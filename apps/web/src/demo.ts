import { ApiError } from './api'
import type { AuditEvent, Catalog, CatalogCreate, Deliverable, Estimate, Project, ProjectPage, ProjectStatus, ProposalExport, ProposalMetadata, Review, Scope, ScopehatchApi, Snapshot } from './types'

/** Local-only, in-memory, synthetic fixture. NOT authentication, tenancy or durable storage. */
export type FixturePersona = 'owner' | 'operator' | 'reviewer'
const people: Record<FixturePersona, string> = { owner: 'fixture-owner', operator: 'fixture-operator', reviewer: 'fixture-reviewer' }
const tenantId = 'fixture-studio'
const copy = <T>(value: T): T => structuredClone(value)
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message, 'fixture-request') }
const safeQuantity = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && (value as number) > 0)
const sampleBrief = 'We need 12 interior images and an exterior hero view for a mixed-use development. 4K output, ideally within two weeks. We have floor plans in PDF; please confirm whether CAD files are needed.'

export const fixtureProjectId = 'fixture-project-001'

interface DemoRecord {
  project: Project
  createdAt: string
  scopes: Scope[]
  estimates: Estimate[]
  reviews: Review[]
  events: AuditEvent[]
}
const initialCatalog: Catalog = {
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
  private catalogVersions: Catalog[] = [copy(initialCatalog)]
  private latestCatalog() { return this.catalogVersions.at(-1) }
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
    const record: DemoRecord = { project, createdAt: '2026-10-21T09:00:00.000Z', scopes: [scope], estimates: [], reviews: [], events: [] }
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
  private requireOwner() {
    if (this.persona !== 'owner') fail(403, 'FORBIDDEN', 'Only the fixture owner can publish rates.')
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
    const latestCatalog = this.latestCatalog()
    if (!latestCatalog) fail(409, 'NO_CATALOG', 'Publish a catalog before estimating.')
    const lines: Estimate['lines'] = scope.deliverables.map(item => {
      const service = latestCatalog!.services.find(s => s.id === item.serviceId)
      if (!service) blockers.push({ code: 'UNPRICED_SERVICE', detail: item.serviceId })
      if (item.quantity === null) blockers.push({ code: 'UNKNOWN_QUANTITY', detail: item.serviceId })
      if (item.source === 'brief' && !item.evidence.trim()) blockers.push({ code: 'MISSING_EVIDENCE', detail: item.serviceId })
      else if (item.source === 'brief' && !scope.brief.includes(item.evidence)) blockers.push({ code: 'EVIDENCE_NOT_IN_BRIEF', detail: item.serviceId })
      const subtotal = item.quantity !== null && service ? item.quantity * service.unitPriceMinor : null
      if (subtotal !== null && !Number.isSafeInteger(subtotal)) fail(422, 'MONEY_OVERFLOW', 'Price exceeds the supported integer range.')
      return { ...item, unitPriceMinor: service?.unitPriceMinor ?? null, subtotalMinor: subtotal }
    })
    const sum = lines.reduce((value, line) => value + (line.subtotalMinor ?? 0), 0)
    if (!Number.isSafeInteger(sum)) fail(422, 'MONEY_OVERFLOW', 'Total exceeds the supported integer range.')
    return {
      tenantId, projectId: scope.projectId, scopeRevision: scope.revision, catalogVersion: latestCatalog!.version,
      currency: latestCatalog!.currency, lines, blockers, state: blockers.length ? 'blocked' : 'ready',
      totalMinor: blockers.length ? null : sum
    }
  }
  private status(record: DemoRecord): ProjectStatus {
    const scope = this.latest(record.scopes)
    const estimate = this.latest(record.estimates)
    const catalog = this.latestCatalog()
    if (!scope || !catalog || !estimate || estimate.scopeRevision !== scope.revision ||
        estimate.catalogVersion !== catalog.version) return 'draft'
    if (estimate.state === 'blocked') return 'blocked'
    const review = this.latest(record.reviews)
    if (review?.scopeRevision === scope.revision && review.catalogVersion === catalog.version) {
      return review.state
    }
    return 'ready'
  }
  async catalogs(): Promise<Catalog[]> { return copy([...this.catalogVersions].reverse()) }
  async createCatalog(body: CatalogCreate): Promise<Catalog> {
    this.requireOwner()
    const latest = this.latestCatalog()
    if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion !== (latest?.version ?? 0))
      fail(409, 'STALE_CATALOG_VERSION', 'Reload current rates before publishing a new version.')
    if (!/^[A-Z]{3}$/.test(body.currency) || !['IDR','USD','EUR','GBP','SGD','AUD','JPY','KRW','VND'].includes(body.currency) ||
        !Array.isArray(body.services) || body.services.length < 1 || body.services.length > 200 ||
        body.services.some(service => !service.id.trim() || !service.label.trim() ||
          !Number.isSafeInteger(service.unitPriceMinor) || service.unitPriceMinor < 0))
      fail(422, 'INVALID_INPUT', 'Provide a valid currency, at least one named service, and safe nonnegative integer prices.')
    const unique = new Set(body.services.map(service => service.id))
    if (unique.size !== body.services.length) fail(422, 'DUPLICATE_SERVICE', 'Service IDs must be unique.')
    const next: Catalog = {tenantId, currency:body.currency, version:body.baseVersion + 1, services:copy(body.services)}
    this.catalogVersions.push(next)
    return copy(next)
  }
  async listProjects(options: {cursor?: string; limit?: number} = {}): Promise<ProjectPage> {
    const limit = options.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail(422, 'INVALID_INPUT', 'Page limit must be from 1 to 100.')
    if (options.cursor && !/^fixture-page-\d+$/.test(options.cursor))
      fail(422, 'INVALID_CURSOR', 'Invalid fixture cursor.')
    const offset = options.cursor ? Number(options.cursor.slice('fixture-page-'.length)) : 0
    if (!Number.isSafeInteger(offset)) fail(422, 'INVALID_CURSOR', 'Invalid fixture cursor.')
    const sorted = [...this.records.values()].sort((a,b) =>
      b.createdAt.localeCompare(a.createdAt) || b.project.id.localeCompare(a.project.id))
    return copy({
      items: sorted.slice(offset,offset + limit).map(record => ({
        id:record.project.id, title:record.project.title, status:this.status(record), createdAt:record.createdAt
      })),
      nextCursor: offset + limit < sorted.length ? 'fixture-page-' + (offset + limit) : null
    })
  }
  async createProject(body: { title: string; brief: string }): Promise<Project> {
    this.requireOperator()
    if (!body.title?.trim() || !body.brief?.trim()) fail(422, 'INVALID_INPUT', 'Project title and original brief are required.')
    const id = 'fixture-project-' + String(this.records.size + 1).padStart(3, '0')
    const project: Project = { id, title: body.title.trim(), brief: body.brief, status: 'draft' }
    const record: DemoRecord = {
      project, createdAt: new Date(Date.UTC(2026, 9, 21, 9, this.records.size)).toISOString(),
      scopes: [], estimates: [], reviews: [], events: []
    }
    this.records.set(id, record)
    this.event(record, 'project.created')
    return copy(project)
  }
  async project(id: string): Promise<Snapshot> {
    const record = this.record(id)
    return copy({
      project: {...record.project, status:this.status(record)},
      latestScope: this.latest(record.scopes),
      latestEstimate: this.latest(record.estimates),
      review: this.latest(record.reviews)
    })
  }
  async createScope(id: string, body: { deliverables: Deliverable[]; unknowns: string[]; proposal?: ProposalMetadata }): Promise<Scope> {
    this.requireOperator()
    const record = this.record(id)
    if (!Array.isArray(body.deliverables) || !Array.isArray(body.unknowns) ||
        !body.unknowns.every(u => typeof u === 'string' && u.trim()) ||
        !body.deliverables.every(d => typeof d.serviceId === 'string' && d.serviceId.trim() &&
          safeQuantity(d.quantity) && typeof d.evidence === 'string' && (d.clientDescription === undefined || typeof d.clientDescription === 'string' && d.clientDescription.length <= 2000) && (d.source === 'brief' || d.source === 'manual')))
      fail(422, 'INVALID_INPUT', 'Deliverables, quantities and unknowns are invalid.')
    const proposal = body.proposal ?? {overview:'', assumptions:[], exclusions:[], commercialTerms:[]}
    const items = [proposal.assumptions,proposal.exclusions,proposal.commercialTerms]
    if (typeof proposal.overview !== 'string' || proposal.overview.length > 4000 ||
        items.some(a => !Array.isArray(a) || a.length > 50 || a.some(x => typeof x !== 'string' || !x.trim() || x.trim().length > 2000)) ||
        JSON.stringify(proposal).length > 65536) fail(422,'INVALID_INPUT','Proposal metadata exceeds the documented limits.')
    const scope: Scope = {
      tenantId, projectId: id, revision: record.scopes.length + 1,
      authorId: people.operator, brief: record.project.brief,
      deliverables: body.deliverables.map(item => ({...copy(item), clientDescription:item.clientDescription ?? ''})),
      unknowns: copy(body.unknowns), proposal:copy(proposal)
    }
    record.scopes.push(scope)
    this.event(record, 'scope.created', scope.revision)
    return copy(scope)
  }
  async estimate(id: string, body: { scopeRevision: number; catalogVersion: number }): Promise<Estimate> {
    this.requireOperator()
    const record = this.record(id)
    const scope = this.latest(record.scopes)!
    if (!scope || scope.revision !== body.scopeRevision || this.latestCatalog()?.version !== body.catalogVersion)
      fail(409, 'STALE_REVISION', 'Estimate requires the latest scope and catalog version.')
    const estimate = this.calculate(scope)
    record.estimates.push(estimate)
    this.event(record, 'estimate.' + estimate.state, scope.revision)
    return copy(estimate)
  }
  async submitReview(id: string, body: { scopeRevision: number; catalogVersion: number }): Promise<Review> {
    this.requireOperator()
    const record = this.record(id)
    const scope = this.latest(record.scopes)!
    const estimate = this.latest(record.estimates)!
    if (!scope || !estimate || scope.revision !== body.scopeRevision ||
        estimate.scopeRevision !== scope.revision || estimate.catalogVersion !== body.catalogVersion)
      fail(409, 'STALE_REVISION', 'Save and estimate the latest revision before requesting review.')
    if (estimate.state !== 'ready') fail(409, 'BLOCKED_ESTIMATE', 'Resolve pricing blockers before requesting review.')
    const previous = this.latest(record.reviews)
    if (previous?.scopeRevision === scope.revision) fail(409, 'REVIEW_EXISTS', 'This revision already has a review.')
    const review: Review = {
      tenantId, projectId: id, scopeRevision: scope.revision, catalogVersion: this.latestCatalog()!.version,
      state: 'pending', submittedBy: people[this.persona], approvedBy: null
    }
    record.reviews.push(review)
    this.event(record, 'review.submitted', scope.revision)
    return copy(review)
  }
  async approve(id: string, body: { scopeRevision: number; catalogVersion: number }): Promise<Review> {
    this.requireReviewer()
    const record = this.record(id)
    const scope = this.latest(record.scopes)!
    const review = this.latest(record.reviews)!
    const estimate = this.latest(record.estimates)!
    if (!scope || !review || !estimate || review.state !== 'pending' ||
        scope.revision !== body.scopeRevision || review.scopeRevision !== scope.revision ||
        review.catalogVersion !== body.catalogVersion || review.catalogVersion !== this.latestCatalog()?.version || estimate.scopeRevision !== scope.revision ||
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
    const scope = this.latest(record.scopes)!
    const estimate = this.latest(record.estimates)!
    const review = this.latest(record.reviews)!
    if (!scope || scope.revision !== revision || !estimate || estimate.scopeRevision !== revision ||
        estimate.state !== 'ready' || !review || review.scopeRevision !== revision ||
        review.catalogVersion !== estimate.catalogVersion || review.catalogVersion !== this.latestCatalog()?.version || review.state !== 'approved')
      fail(409, 'APPROVAL_REQUIRED', 'Export requires approval of the exact current scope and catalog revision.')
    const rows = estimate.lines.map(l => {
      const label = this.latestCatalog()?.services.find(s => s.id === l.serviceId)?.label ?? l.serviceId
      return '- ' + label + ': ' + l.quantity + ' × ' + l.unitPriceMinor + ' = ' + l.subtotalMinor + ' ' + estimate.currency + ' minor units' + (l.clientDescription ? '\n  ' + l.clientDescription : '')
    })
    const markdown = [
      '# Proposal draft — ' + record.project.title, '', 'Project: ' + id,
      'Scope revision: ' + revision, 'Catalog version: ' + estimate.catalogVersion, '',
      '## Overview', scope.proposal?.overview ?? '', '', '## Deliverables', ...rows, '',
       '## Assumptions', ...(scope.proposal?.assumptions ?? []), '',
       '## Exclusions', ...(scope.proposal?.exclusions ?? []), '',
       '## Commercial terms', ...(scope.proposal?.commercialTerms ?? []), '',
       'Total: ' + estimate.totalMinor + ' ' + estimate.currency + ' minor units',
      '', 'Approved by: ' + review.approvedBy,
      '', 'Draft proposal only. No message has been sent.'
    ].join('\n')
    this.event(record, 'proposal.exported', revision)
    return copy({ projectId: id, revision, currency: estimate.currency, totalMinor: estimate.totalMinor!, markdown, proposal:scope.proposal ?? {overview:'', assumptions:[], exclusions:[], commercialTerms:[]} })
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
