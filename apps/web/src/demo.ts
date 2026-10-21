import { ApiError } from './api'
import type { AuditEvent, Catalog, Deliverable, Estimate, Project, ProposalExport, Review, Scope, ScopehatchApi, Snapshot } from './types'

/** Local-only, in-memory, synthetic fixture. NOT authentication, tenancy or durable storage. */
export type FixturePersona = 'operator' | 'reviewer'
const people: Record<FixturePersona, string> = { operator: 'fixture-operator', reviewer: 'fixture-reviewer' }
const tenantId = 'fixture-studio'
const copy = <T>(value: T): T => structuredClone(value)
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message, 'fixture-request') }
const safeQuantity = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && (value as number) > 0)
const sampleBrief = 'We need 12 interior images and an exterior hero view for a mixed-use development. 4K output, ideally within two weeks. We have floor plans in PDF; please confirm whether CAD files are needed.'

export const fixtureProjectId = 'fixture-project-001'

interface DemoRecord {
  project: Project
  scopes: Scope[]
  estimates: Estimate[]
  reviews: Review[]
  events: AuditEvent[]
}
const catalog: Catalog = {
  tenantId, currency: 'IDR', version: 1,
  services: [
    { id: 'interior-view', label: 'Interior visualization · per view', unitPriceMinor: 1250000 },
    { id: 'exterior-view', label: 'Exterior visualization · per view', unitPriceMinor: 2000000 },
    { id: 'animation-second', label: 'Animation · per finished second', unitPriceMinor: 375000 },
    { id: 'revision-round', label: 'Additional revision round', unitPriceMinor: 750000 }
  ]
}
export class DemoApi implements ScopehatchApi {
  readonly fixture = true
  persona: FixturePersona = 'operator'
  private records = new Map<string, DemoRecord>()
  private sequence = 1
  constructor() {
    const project: Project = { id: fixtureProjectId, title: 'Aster / development visuals', brief: sampleBrief, status: 'draft' }
    const scope: Scope = {
      tenantId, projectId: project.id, revision: 1, authorId: people.operator,
      brief: sampleBrief,
      deliverables: [
        { serviceId: 'interior-view', quantity: 12, evidence: '12 interior images', source: 'brief' },
        { serviceId: 'exterior-view', quantity: null, evidence: 'an exterior hero view', source: 'brief' }
      ],
      unknowns: ['Confirm whether source CAD files are available']
    }
    const record: DemoRecord = { project, scopes: [scope], estimates: [], reviews: [], events: [] }
    this.records.set(project.id, record)
    record.estimates.push(this.calculate(scope))
    this.event(record, 'project.created', 1)
    this.event(record, 'scope.created', 1)
    this.event(record, 'estimate.blocked', 1)
  }
  selectPersona(persona: FixturePersona) { this.persona = persona }
  private requireOperator() {
    if (this.persona !== 'operator') fail(403, 'FORBIDDEN', 'The fixture reviewer cannot edit scope or submit reviews.')
  }
  private requireReviewer() {
    if (this.persona !== 'reviewer') fail(403, 'FORBIDDEN', 'A separate reviewer is required to approve this work.')
  }
  private record(id: string): DemoRecord {
    const record = this.records.get(id)
    if (!record) fail(404, 'NOT_FOUND', 'Project not found.')
    return record!
  }
  private event(record: DemoRecord, action: string, revision?: number) {
    const serial = this.sequence++
    record.events.unshift({
      id: 'fixture-event-' + serial, action, actorId: people[this.persona],
      timestamp: new Date(Date.UTC(2026, 9, 21, 8, serial % 60, 0)).toISOString(),
      scopeRevision: revision, outcome: 'success', requestId: 'fixture-' + serial
    })
  }
  private latest<T>(items: T[]): T | undefined { return items.at(-1) }
  private calculate(scope: Scope): Estimate {
    const blockers: Estimate['blockers'] = scope.unknowns.map(detail => ({ code: 'UNKNOWN_REQUIREMENT', detail }))
    if (!scope.deliverables.length) blockers.push({ code: 'EMPTY_SCOPE', detail: 'Add at least one deliverable.' })
    const lines: Estimate['lines'] = scope.deliverables.map(item => {
      const service = catalog.services.find(s => s.id === item.serviceId)
      if (!service) blockers.push({ code: 'UNPRICED_SERVICE', detail: item.serviceId })
      if (item.quantity === null) blockers.push({ code: 'UNKNOWN_QUANTITY', detail: item.serviceId })
      if (item.source === 'brief' && !item.evidence.trim()) blockers.push({ code: 'MISSING_EVIDENCE', detail: item.serviceId })
      const subtotal = item.quantity !== null && service ? item.quantity * service.unitPriceMinor : null
      if (subtotal !== null && !Number.isSafeInteger(subtotal)) fail(422, 'MONEY_OVERFLOW', 'Price exceeds the supported integer range.')
      return { ...item, unitPriceMinor: service?.unitPriceMinor ?? null, subtotalMinor: subtotal }
    })
    const sum = lines.reduce((value, line) => value + (line.subtotalMinor ?? 0), 0)
    if (!Number.isSafeInteger(sum)) fail(422, 'MONEY_OVERFLOW', 'Total exceeds the supported integer range.')
    return {
      tenantId, projectId: scope.projectId, scopeRevision: scope.revision, catalogVersion: catalog.version,
      currency: catalog.currency, lines, blockers, state: blockers.length ? 'blocked' : 'ready',
      totalMinor: blockers.length ? null : sum
    }
  }
  async catalogs(): Promise<Catalog[]> { return copy([catalog]) }
  async createProject(body: { title: string; brief: string }): Promise<Project> {
    this.requireOperator()
    if (!body.title?.trim() || !body.brief?.trim()) fail(422, 'INVALID_INPUT', 'Project title and original brief are required.')
    const id = 'fixture-project-' + String(this.records.size + 1).padStart(3, '0')
    const project: Project = { id, title: body.title.trim(), brief: body.brief, status: 'draft' }
    const record: DemoRecord = { project, scopes: [], estimates: [], reviews: [], events: [] }
    this.records.set(id, record)
    this.event(record, 'project.created')
    return copy(project)
  }
  async project(id: string): Promise<Snapshot> {
    const record = this.record(id)
    return copy({
      project: record.project,
      latestScope: this.latest(record.scopes),
      latestEstimate: this.latest(record.estimates),
      review: this.latest(record.reviews)
    })
  }
  async createScope(id: string, body: { deliverables: Deliverable[]; unknowns: string[] }): Promise<Scope> {
    this.requireOperator()
    const record = this.record(id)
    if (!Array.isArray(body.deliverables) || !Array.isArray(body.unknowns) ||
        !body.unknowns.every(u => typeof u === 'string' && u.trim()) ||
        !body.deliverables.every(d => typeof d.serviceId === 'string' && d.serviceId.trim() &&
          safeQuantity(d.quantity) && typeof d.evidence === 'string' && (d.source === 'brief' || d.source === 'manual')))
      fail(422, 'INVALID_INPUT', 'Deliverables, quantities and unknowns are invalid.')
    const scope: Scope = {
      tenantId, projectId: id, revision: record.scopes.length + 1,
      authorId: people.operator, brief: record.project.brief,
      deliverables: copy(body.deliverables), unknowns: copy(body.unknowns)
    }
    record.scopes.push(scope)
    this.event(record, 'scope.created', scope.revision)
    return copy(scope)
  }
  async estimate(id: string, body: { scopeRevision: number; catalogVersion: number }): Promise<Estimate> {
    this.requireOperator()
    const record = this.record(id)
    const scope = this.latest(record.scopes)
    if (!scope || scope.revision !== body.scopeRevision || catalog.version !== body.catalogVersion)
      fail(409, 'STALE_REVISION', 'Estimate requires the latest scope and catalog version.')
    const estimate = this.calculate(scope)
    record.estimates.push(estimate)
    this.event(record, 'estimate.' + estimate.state, scope.revision)
    return copy(estimate)
  }
  async submitReview(id: string, body: { scopeRevision: number; catalogVersion: number }): Promise<Review> {
    this.requireOperator()
    const record = this.record(id)
    const scope = this.latest(record.scopes)
    const estimate = this.latest(record.estimates)
    if (!scope || !estimate || scope.revision !== body.scopeRevision ||
        estimate.scopeRevision !== scope.revision || estimate.catalogVersion !== body.catalogVersion)
      fail(409, 'STALE_REVISION', 'Save and estimate the latest revision before requesting review.')
    if (estimate.state !== 'ready') fail(409, 'BLOCKED_ESTIMATE', 'Resolve pricing blockers before requesting review.')
    const previous = this.latest(record.reviews)
    if (previous?.scopeRevision === scope.revision) fail(409, 'REVIEW_EXISTS', 'This revision already has a review.')
    const review: Review = {
      tenantId, projectId: id, scopeRevision: scope.revision, catalogVersion: catalog.version,
      state: 'pending', submittedBy: people.operator, approvedBy: null
    }
    record.reviews.push(review)
    this.event(record, 'review.submitted', scope.revision)
    return copy(review)
  }
  async approve(id: string, body: { scopeRevision: number; catalogVersion: number }): Promise<Review> {
    this.requireReviewer()
    const record = this.record(id)
    const scope = this.latest(record.scopes)
    const review = this.latest(record.reviews)
    const estimate = this.latest(record.estimates)
    if (!scope || !review || !estimate || review.state !== 'pending' ||
        scope.revision !== body.scopeRevision || review.scopeRevision !== scope.revision ||
        review.catalogVersion !== body.catalogVersion || estimate.scopeRevision !== scope.revision ||
        estimate.state !== 'ready')
      fail(409, 'STALE_REVIEW', 'Only the pending review of the current ready revision can be approved.')
    if (review.submittedBy === people[this.persona]) fail(403, 'SELF_APPROVAL', 'A different person must approve.')
    review.state = 'approved'
    review.approvedBy = people.reviewer
    this.event(record, 'review.approved', scope.revision)
    return copy(review)
  }
  async export(id: string, revision: number): Promise<ProposalExport> {
    const record = this.record(id)
    const scope = this.latest(record.scopes)
    const estimate = this.latest(record.estimates)
    const review = this.latest(record.reviews)
    if (!scope || scope.revision !== revision || !estimate || estimate.scopeRevision !== revision ||
        estimate.state !== 'ready' || !review || review.scopeRevision !== revision ||
        review.catalogVersion !== estimate.catalogVersion || review.state !== 'approved')
      fail(409, 'APPROVAL_REQUIRED', 'Export requires approval of the exact current scope and catalog revision.')
    const rows = estimate.lines.map(l => {
      const label = catalog.services.find(s => s.id === l.serviceId)?.label ?? l.serviceId
      return '- ' + label + ': ' + l.quantity + ' × ' + l.unitPriceMinor + ' = ' + l.subtotalMinor + ' ' + estimate.currency + ' minor units'
    })
    const markdown = [
      '# Proposal draft — ' + record.project.title, '', 'Project: ' + id,
      'Scope revision: ' + revision, 'Catalog version: ' + estimate.catalogVersion, '',
      '## Deliverables', ...rows, '', 'Total: ' + estimate.totalMinor + ' ' + estimate.currency + ' minor units',
      '', 'Approved by: ' + review.approvedBy,
      '', 'Draft proposal only. No message has been sent.'
    ].join('\n')
    this.event(record, 'proposal.exported', revision)
    return copy({ projectId: id, revision, currency: estimate.currency, totalMinor: estimate.totalMinor!, markdown })
  }
  async audit(id: string, cursor?: string, limit = 30) {
    const record = this.record(id)
    if (cursor && !/^\d+$/.test(cursor)) fail(422, 'INVALID_CURSOR', 'The audit cursor is invalid.')
    const offset = cursor ? Number(cursor) : 0
    if (!Number.isSafeInteger(offset) || limit < 1 || limit > 100) fail(422, 'INVALID_PAGE', 'Invalid audit page.')
    const items = record.events.slice(offset, offset + limit)
    return copy({ items, nextCursor: offset + limit < record.events.length ? String(offset + limit) : null })
  }
}
