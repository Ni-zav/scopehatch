import { describe, expect, it } from 'vitest'
import { DemoApi, fixtureProjectId } from './demo'

async function prepare(api: DemoApi) {
  const before = await api.project(fixtureProjectId)
  const lines = before.latestScope!.deliverables.map(d => ({
    ...d, quantity: d.serviceId === 'exterior-view' ? 1 : d.quantity
  }))
  const scope = await api.createScope(fixtureProjectId, { deliverables: lines, unknowns: [] })
  const estimate = await api.estimate(fixtureProjectId, { scopeRevision: scope.revision, catalogVersion: 1 })
  return { scope, estimate }
}
describe('deterministic demo fixture — NOT production auth', () => {
  it('starts blocked for unknown quantity and unresolved requirement', async () => {
    const api = new DemoApi()
    const result = await api.project(fixtureProjectId)
    expect(result.latestScope?.revision).toBe(1)
    expect(result.latestEstimate?.state).toBe('blocked')
    expect(result.latestEstimate?.totalMinor).toBeNull()
    expect(result.latestEstimate?.blockers.map(b => b.code)).toContain('UNKNOWN_QUANTITY')
    expect(result.latestEstimate?.blockers.map(b => b.code)).toContain('UNKNOWN_REQUIREMENT')
    await expect(api.export(fixtureProjectId, 1)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
  })
  it('follows two-person review and exports the exact approved version', async () => {
    const api = new DemoApi()
    const { scope, estimate } = await prepare(api)
    expect(estimate.totalMinor).toBe(17000000)
    expect(estimate.state).toBe('ready')
    await api.submitReview(fixtureProjectId, { scopeRevision: scope.revision, catalogVersion: 1 })
    await expect(api.approve(fixtureProjectId, { scopeRevision: scope.revision, catalogVersion: 1 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    api.selectPersona('reviewer')
    const review = await api.approve(fixtureProjectId, { scopeRevision: scope.revision, catalogVersion: 1 })
    expect(review.state).toBe('approved')
    expect(review.submittedBy).not.toBe(review.approvedBy)
    const result = await api.export(fixtureProjectId, scope.revision)
    expect(result.revision).toBe(scope.revision)
    expect(result.markdown).toContain('Total: 17000000 IDR minor units')
    expect((await api.audit(fixtureProjectId)).items[0]?.action).toBe('proposal.exported')
  })
  it('supersedes an approval instead of carrying it to a new revision', async () => {
    const api = new DemoApi()
    const { scope } = await prepare(api)
    await api.submitReview(fixtureProjectId, { scopeRevision: scope.revision, catalogVersion: 1 })
    api.selectPersona('reviewer')
    await api.approve(fixtureProjectId, { scopeRevision: scope.revision, catalogVersion: 1 })
    api.selectPersona('operator')
    const later = await api.createScope(fixtureProjectId, {
      deliverables: [{ serviceId: 'interior-view', quantity: 3, evidence: 'Manually agreed', source: 'manual' }],
      unknowns: []
    })
    await api.estimate(fixtureProjectId, { scopeRevision: later.revision, catalogVersion: 1 })
    await expect(api.export(fixtureProjectId, scope.revision)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(api.export(fixtureProjectId, later.revision)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    api.selectPersona('reviewer')
    await expect(api.approve(fixtureProjectId, { scopeRevision: later.revision, catalogVersion: 1 }))
      .rejects.toMatchObject({ code: 'STALE_REVIEW' })
  })
  it('never allows a fixture reviewer to create or submit work', async () => {
    const api = new DemoApi()
    api.selectPersona('reviewer')
    await expect(api.createProject({ title: 'X', brief: 'Some original text' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(api.createScope(fixtureProjectId, { deliverables: [], unknowns: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(api.submitReview(fixtureProjectId, { scopeRevision: 1, catalogVersion: 1 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('enforces unknown IDs, stale versions and nonempty evidence', async () => {
    const api = new DemoApi()
    await expect(api.project('other-tenant-project')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(api.estimate(fixtureProjectId, { scopeRevision: 99, catalogVersion: 1 }))
      .rejects.toMatchObject({ code: 'STALE_REVISION' })
    const scope = await api.createScope(fixtureProjectId, {
      deliverables: [{ serviceId: 'interior-view', quantity: 1, source: 'brief', evidence: '' }],
      unknowns: []
    })
    const quote = await api.estimate(fixtureProjectId, { scopeRevision: scope.revision, catalogVersion: 1 })
    expect(quote.blockers.map(b => b.code)).toContain('MISSING_EVIDENCE')
    const mismatch = await api.createScope(fixtureProjectId, { deliverables: [
      { serviceId: 'interior-view', quantity: 1, source: 'brief', evidence: 'fabricated client quote' }
    ], unknowns: [] })
    const mismatchEstimate = await api.estimate(fixtureProjectId, { scopeRevision: mismatch.revision, catalogVersion: 1 })
    expect(mismatchEstimate.blockers.map(b => b.code)).toContain('EVIDENCE_NOT_IN_BRIEF')
    await expect(api.submitReview(fixtureProjectId, { scopeRevision: mismatch.revision, catalogVersion: 1 }))
      .rejects.toMatchObject({ code: 'BLOCKED_ESTIMATE' })
  })
  it('rejects unsafe amounts and quantities, not silently rounding money', async () => {
    const api = new DemoApi()
    await expect(api.createScope(fixtureProjectId, {
      deliverables: [{ serviceId: 'interior-view', quantity: 1.5, evidence: 'manual', source: 'manual' }],
      unknowns: []
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const scope = await api.createScope(fixtureProjectId, {
      deliverables: [{ serviceId: 'interior-view', quantity: Number.MAX_SAFE_INTEGER, evidence: 'test', source: 'manual' }],
      unknowns: []
    })
    await expect(api.estimate(fixtureProjectId, { scopeRevision: scope.revision, catalogVersion: 1 }))
      .rejects.toMatchObject({ code: 'MONEY_OVERFLOW' })
  })
  it('paginates audit events and keeps fixture runs independent', async () => {
    const api = new DemoApi()
    const first = await api.audit(fixtureProjectId, undefined, 2)
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await api.audit(fixtureProjectId, first.nextCursor!, 2)
    expect(second.items).toHaveLength(1)
    const other = new DemoApi()
    await api.createProject({ title: 'Synthetic', brief: 'Example brief' })
    await expect(other.project('fixture-project-002')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
