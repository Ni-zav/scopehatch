import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog, createScopeRevision, estimateScope, submitReview, approveReview, exportProposal } from '../src/domain.mjs';

const author = { id: 'alice', tenantId: 'studio-a', roles: ['owner'] };
const reviewer = { id: 'bob', tenantId: 'studio-a', roles: ['reviewer'] };
const catalog = createCatalog({
  tenantId: 'studio-a', currency: 'USD', version: 1,
  services: [{ id: 'render', label: 'Architectural render', unitPriceMinor: 18000 }]
});
const scope = createScopeRevision({
  tenantId: 'studio-a', projectId: 'p-1', revision: 1, authorId: 'alice',
  brief: '4 exterior renders, please.',
  deliverables: [{ serviceId: 'render', quantity: 4, evidence: '4 exterior renders' }]
});
const quote = estimateScope(scope, catalog);
const review = submitReview({ scope, estimate: quote, actor: author });

test('catalog quote uses integer arithmetic only', () => {
  assert.equal(quote.state, 'ready');
  assert.equal(quote.totalMinor, 72000);
});

test('approved exact revision can be exported', () => {
  const approved = approveReview({ scope, estimate: quote, review, actor: reviewer });
  assert.match(exportProposal({ scope, estimate: quote, review: approved }).markdown, /72000/);
});

test('missing quantities and unknown requirements block review', () => {
  const incomplete = createScopeRevision({
    ...scope, revision: 2, unknowns: ['revision count'],
    deliverables: [{ serviceId: 'render', quantity: null, evidence: '' }]
  });
  const result = estimateScope(incomplete, catalog);
  assert.equal(result.totalMinor, null);
  assert.equal(result.state, 'blocked');
  assert.throws(() => submitReview({ scope: incomplete, estimate: result, actor: author }),
    { code: 'BLOCKED_ESTIMATE' });
});

test('never price from model-suggested unknown service', () => {
  const changed = createScopeRevision({
    ...scope, revision: 2,
    deliverables: [{ serviceId: 'premium-from-model', quantity: 5, evidence: '' }]
  });
  assert.deepEqual(estimateScope(changed, catalog).blockers.map(b => b.code),
    ['UNPRICED_SERVICE', 'MISSING_EVIDENCE']);
});

test('catalog of another tenant is rejected', () => {
  assert.throws(() => estimateScope({ ...scope, tenantId: 'studio-b' }, catalog),
    { code: 'TENANT_MISMATCH' });
  assert.throws(() => approveReview({
    scope, estimate: quote, review, actor: { ...reviewer, tenantId: 'studio-b' }
  }), { code: 'TENANT_MISMATCH' });
});

test('self-approval and missing reviewer permissions fail', () => {
  assert.throws(() => approveReview({ scope, estimate: quote, review, actor: author }),
    { code: 'SELF_APPROVAL' });
  assert.throws(() => approveReview({
    scope, estimate: quote, review,
    actor: { id: 'guest', tenantId: 'studio-a', roles: [] }
  }), { code: 'FORBIDDEN' });
});

test('revision changes invalidate quote and approval', () => {
  const next = createScopeRevision({ ...scope, revision: 2 });
  const approved = approveReview({ scope, estimate: quote, review, actor: reviewer });
  assert.throws(() => exportProposal({ scope: next, estimate: quote, review: approved }),
    { code: 'STALE_ESTIMATE' });
});

test('duplicate service, invalid quantity and integer overflow fail', () => {
  assert.throws(() => createCatalog({ ...catalog, services: [...catalog.services, ...catalog.services] }),
    { code: 'DUPLICATE_SERVICE' });
  assert.throws(() => createScopeRevision({
    ...scope, deliverables: [{ serviceId: 'render', quantity: 0, evidence: 'x' }]
  }), { code: 'INVALID_INPUT' });
  const large = createCatalog({
    tenantId: 'studio-a', currency: 'USD', version: 2,
    services: [{ id: 'render', label: 'Architectural render', unitPriceMinor: Number.MAX_SAFE_INTEGER }]
  });
  assert.throws(() => estimateScope(scope, large), { code: 'MONEY_OVERFLOW' });
});
