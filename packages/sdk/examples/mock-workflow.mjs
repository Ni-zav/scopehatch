/** Deterministic offline example; no API server, authorization or AI is exercised. */
import { ScopehatchClient, staticBearerToken } from '../dist/src/index.js';

const project = { id: 'demo-1', title: 'Concept visuals', brief: 'Two exterior views', status: 'draft' };
const deliverables = [{ serviceId: 'exterior', quantity: 2, evidence: 'Two exterior views', source: 'brief' }];
const scope = { tenantId: 'fixture-tenant', projectId: project.id, revision: 1,
  authorId: 'fixture-operator', brief: project.brief, deliverables, unknowns: [] };
const binding = { scopeRevision: 1, catalogVersion: 1 };
const estimate = { tenantId: 'fixture-tenant', projectId: project.id, ...binding, currency: 'USD',
  lines: [{ ...deliverables[0], unitPriceMinor: 5000, subtotalMinor: 10000 }],
  blockers: [], state: 'ready', totalMinor: 10000 };
const pending = { tenantId: 'fixture-tenant', projectId: project.id, ...binding,
  state: 'pending', submittedBy: 'fixture-operator', approvedBy: null };
const approved = { ...pending, state: 'approved', approvedBy: 'fixture-reviewer' };

const fixtures = new Map([
  ['POST /v1/projects', { project }],
  ['POST /v1/projects/demo-1/scopes', { scope }],
  ['POST /v1/projects/demo-1/estimates', { estimate }],
  ['POST /v1/projects/demo-1/reviews', { review: pending }],
  ['POST /v1/projects/demo-1/approve', { review: approved }],
  ['GET /v1/projects/demo-1/exports/1', {
    projectId: project.id, revision: 1, currency: 'USD', totalMinor: 10000,
    markdown: '# Approved concept visuals (fixture)\n\nTwo exterior views',
  }],
  ['GET /v1/projects/demo-1/audit', { items: [{ action: 'review.approved', actorId: 'fixture-reviewer' }], nextCursor: null }],
]);

const client = new ScopehatchClient({
  baseUrl: 'https://mock.scopehatch.invalid',
  credentials: staticBearerToken('fake-test-token'),
  fetch: async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    const fixture = fixtures.get(key);
    if (!fixture) return new Response(JSON.stringify({ error: {
      code: 'NOT_FOUND', message: 'No fixture', requestId: 'mock-1',
    } }), { status: 404 });
    return new Response(JSON.stringify(fixture), { status: init.method === 'POST' ? 201 : 200 });
  },
});

const created = await client.createProject({ title: project.title, brief: project.brief }, { idempotencyKey: 'demo-create' });
const savedScope = await client.createScope(created.id, { deliverables, unknowns: [] }, { idempotencyKey: 'demo-scope' });
const quote = await client.createEstimate(created.id, binding, { idempotencyKey: 'demo-estimate' });
const review = await client.submitReview(created.id, binding, { idempotencyKey: 'demo-review' });
// Separate simulated reviewer principal on the server. The SDK supplies neither identity nor role.
const approvedReview = await client.approveReview(created.id, binding, { idempotencyKey: 'demo-approval' });
const exported = await client.exportApprovedProposal(created.id, savedScope.revision);
const audit = await client.listAudit(created.id);
console.log(JSON.stringify({ project: created.id, scopeRevision: savedScope.revision,
  estimatedMinor: quote.totalMinor, reviewState: review.state, approvedBy: approvedReview.approvedBy,
  exported: exported.markdown, auditEvents: audit.items.length, mockOnly: true }, null, 2));
