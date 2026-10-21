import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ScopehatchClient, staticBearerToken, ScopehatchHttpError, ScopehatchAbortError,
  ScopehatchTimeoutError, ScopehatchNetworkError, ScopehatchProtocolError,
  ScopehatchConfigurationError, ScopehatchAuthenticationError,
} from '../dist/src/index.js';

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const apiError = (status, code) => json({ error: { code, message: 'Server detail is not exposed', requestId: 'req-1' } }, status);
function harness(responses, options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const value = responses.shift();
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value(url, init);
    assert.ok(value, 'Unexpected extra HTTP request');
    return value;
  };
  return {
    calls,
    client: new ScopehatchClient({
      baseUrl: 'https://scope.test/', credentials: staticBearerToken('fixture-token'),
      fetch, retryDelayMs: 0, maxRetryDelayMs: 0, ...options,
    }),
  };
}
const binding = { scopeRevision: 1, catalogVersion: 2 };
const write = (idempotencyKey) => ({ idempotencyKey });

test('typed workflow invokes exactly the contract endpoints, with distinct human approvals', async () => {
  const project = { id: 'p/1', title: 'Views', brief: 'Two exterior views', status: 'draft' };
  const deliverables = [{ serviceId: 'exterior', quantity: 2, evidence: 'Two exterior views', source: 'brief' }];
  const scope = { tenantId: 't-1', projectId: 'p/1', revision: 1, authorId: 'operator', brief: project.brief, deliverables, unknowns: [] };
  const estimate = { tenantId: 't-1', projectId: 'p/1', scopeRevision: 1, catalogVersion: 2, currency: 'USD', lines: [], blockers: [], state: 'ready', totalMinor: 12000 };
  const pending = { tenantId: 't-1', projectId: 'p/1', ...binding, state: 'pending', submittedBy: 'operator', approvedBy: null };
  const approved = { ...pending, state: 'approved', approvedBy: 'reviewer' };
  const exportValue = { projectId: 'p/1', revision: 1, currency: 'USD', totalMinor: 12000, markdown: '# Approved' };
  const { client, calls } = harness([
    json({ items: [{ tenantId: 't-1', currency: 'USD', version: 2, services: [] }] }),
    json({ project }, 201), json({ project, latestScope: scope }), json({ scope }, 201),
    json({ estimate }, 201), json({ review: pending }, 201), json({ review: approved }),
    json(exportValue), json({ items: [{ action: 'approved' }], nextCursor: 'cursor#1' }),
    json({ items: [{ action: 'exported' }], nextCursor: null }),
  ]);
  assert.equal((await client.listCatalogs())[0].version, 2);
  assert.deepEqual(await client.createProject({ title: project.title, brief: project.brief }, write('create-1')), project);
  assert.deepEqual((await client.getProject('p/1')).latestScope, scope);
  assert.deepEqual(await client.createScope('p/1', { deliverables, unknowns: [] }, write('scope-1')), scope);
  assert.equal((await client.createEstimate('p/1', binding, write('estimate-1'))).totalMinor, 12000);
  assert.equal((await client.submitReview('p/1', binding, write('review-1'))).state, 'pending');
  assert.equal((await client.approveReview('p/1', binding, write('approve-1'))).approvedBy, 'reviewer');
  assert.deepEqual(await client.exportApprovedProposal('p/1', 1), exportValue);
  const page = await client.listAudit('p/1', { limit: 1 });
  assert.equal(page.nextCursor, 'cursor#1');
  assert.equal((await client.listAudit('p/1', { cursor: page.nextCursor, limit: 1 })).nextCursor, null);
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), [
    '/v1/catalogs', '/v1/projects', '/v1/projects/p%2F1', '/v1/projects/p%2F1/scopes',
    '/v1/projects/p%2F1/estimates', '/v1/projects/p%2F1/reviews',
    '/v1/projects/p%2F1/approve', '/v1/projects/p%2F1/exports/1',
    '/v1/projects/p%2F1/audit', '/v1/projects/p%2F1/audit',
  ]);
  assert.equal(new URL(calls[9].url).searchParams.get('cursor'), 'cursor#1');
  const posts = calls.filter(c => c.init.method === 'POST');
  assert.deepEqual(posts.map(c => c.init.headers['Idempotency-Key']),
    ['create-1', 'scope-1', 'estimate-1', 'review-1', 'approve-1']);
  assert.ok(calls.every(c => c.init.headers.Authorization === 'Bearer fixture-token'));
  assert.equal(calls[0].init.headers['Idempotency-Key'], undefined);
  assert.deepEqual(JSON.parse(calls[5].init.body), binding);
});

test('only allowlisted mutation fields are serialized (no tenant, role, approval or price forgery)', async () => {
  const { client, calls } = harness([json({ project: { id: 'x' } }, 201), json({ scope: { revision: 1 } }, 201)]);
  await client.createProject({ title: 'A', brief: 'B', tenantId: 'forged', roles: ['owner'] }, write('k1'));
  await client.createScope('x', { unknowns: [], deliverables: [{
    serviceId: 's', quantity: null, evidence: '', source: 'manual',
    unitPriceMinor: 0, state: 'approved', approvedBy: 'self',
  }], tenantId: 'forged' }, write('k2'));
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'A', brief: 'B' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { unknowns: [], deliverables: [
    { serviceId: 's', quantity: null, evidence: '', source: 'manual' },
  ] });
});

test('idempotency key and version are mandatory and validated before any network request', async () => {
  const { client, calls } = harness([]);
  await assert.rejects(client.createProject({ title: 'A', brief: 'B' }), ScopehatchConfigurationError);
  await assert.rejects(client.createProject({ title: 'A', brief: 'B' }, write('bad\nheader')), ScopehatchConfigurationError);
  await assert.rejects(client.createEstimate('a', { scopeRevision: 0, catalogVersion: 2 }, write('safe')), ScopehatchConfigurationError);
  await assert.rejects(client.exportApprovedProposal('a', -1), ScopehatchConfigurationError);
  await assert.rejects(client.listAudit('a', { limit: 0 }), ScopehatchConfigurationError);
  await assert.rejects(client.getProject(''), ScopehatchConfigurationError);
  assert.equal(calls.length, 0);
});

test('GET retries transient HTTP and network errors; HTTP auth/tenant/conflict errors are never retried', async () => {
  const { client, calls } = harness([apiError(503, 'UNAVAILABLE'), new Error('secret token in transport'), json({ items: [] })]);
  assert.deepEqual(await client.listCatalogs(), []);
  assert.equal(calls.length, 3);
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'STALE_REVISION'], [422, 'INVALID_INPUT']]) {
    const fixture = harness([apiError(status, code)]);
    await assert.rejects(fixture.client.getProject('other-tenant'), (err) => {
      assert.ok(err instanceof ScopehatchHttpError);
      assert.equal(err.status, status);
      assert.equal(err.code, code);
      assert.equal(err.requestId, 'req-1');
      assert.doesNotMatch(err.message, /Server detail/);
      return true;
    });
    assert.equal(fixture.calls.length, 1);
  }
});

test('POST is not retried by default; explicit retry reuses exactly the same idempotency key', async () => {
  const defaultPost = harness([apiError(503, 'UNAVAILABLE')]);
  await assert.rejects(defaultPost.client.createProject({ title: 'A', brief: 'B' }, write('one')), ScopehatchHttpError);
  assert.equal(defaultPost.calls.length, 1);
  const optIn = harness([apiError(503, 'UNAVAILABLE'), json({ project: { id: 'x' } }, 201)]);
  assert.equal((await optIn.client.createProject({ title: 'A', brief: 'B' }, { ...write('same-key'), retry: true })).id, 'x');
  assert.equal(optIn.calls.length, 2);
  assert.equal(optIn.calls[0].init.headers['Idempotency-Key'], 'same-key');
  assert.equal(optIn.calls[1].init.headers['Idempotency-Key'], 'same-key');
  assert.equal(optIn.calls[0].init.body, optIn.calls[1].init.body);
});

test('approved export failure remains an error, never fabricated markdown', async () => {
  const { client } = harness([apiError(409, 'STALE_REVISION')]);
  await assert.rejects(client.exportApprovedProposal('p', 1), (error) =>
    error instanceof ScopehatchHttpError && error.status === 409);
});

test('cancellation propagates to injected transport with typed abort', async () => {
  const controller = new AbortController();
  let capturedSignal;
  const { client } = harness([(_url, init) => {
    capturedSignal = init.signal;
    return new Promise(() => {});
  }]);
  const pending = client.getProject('p', { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, ScopehatchAbortError);
  assert.equal(capturedSignal.aborted, true);
  await assert.rejects(client.getProject('p', { signal: controller.signal }), ScopehatchAbortError);
});

test('one overall timeout bounds a noncooperative transport and slow credential provider', async () => {
  const { client, calls } = harness([() => new Promise(() => {})], { timeoutMs: 12, maxRetries: 0 });
  await assert.rejects(client.getProject('p'), ScopehatchTimeoutError);
  assert.equal(calls.length, 1);
  const slowProvider = new ScopehatchClient({ baseUrl: 'https://scope.test',
    credentials: { getAccessToken: () => new Promise(() => {}) },
    fetch: () => { throw new Error('should not be called'); }, timeoutMs: 12,
  });
  await assert.rejects(slowProvider.getProject('p'), ScopehatchTimeoutError);
});

test('transport failure is redacted, invalid JSON and wrong envelopes are protocol failures', async () => {
  const { client } = harness([new Error('contains bearer-token-fixture')], { maxRetries: 0 });
  await assert.rejects(client.listCatalogs(), (error) =>
    error instanceof ScopehatchNetworkError && !error.message.includes('bearer-token-fixture'));
  const malformed = harness([new Response('invalid')]);
  await assert.rejects(malformed.client.getProject('p'), ScopehatchProtocolError);
  const empty = harness([json({ success: true })]);
  await assert.rejects(empty.client.createProject({ title: 'a', brief: 'b' }, write('x')), ScopehatchProtocolError);
  const wrongAudit = harness([json({ items: [], nextCursor: 10 })]);
  await assert.rejects(wrongAudit.client.listAudit('p'), ScopehatchProtocolError);
});

test('credential provider is invoked for each attempt and missing credentials fail closed', async () => {
  let calls = 0;
  const { client, calls: requests } = harness([apiError(503, 'DOWN'), json({ items: [] })], {
    credentials: { getAccessToken: async () => `rotated-${++calls}` },
  });
  await client.listCatalogs();
  assert.equal(requests[0].init.headers.Authorization, 'Bearer rotated-1');
  assert.equal(requests[1].init.headers.Authorization, 'Bearer rotated-2');
  const noToken = harness([], { credentials: { getAccessToken: () => '' } });
  await assert.rejects(noToken.client.getProject('x'), ScopehatchAuthenticationError);
  assert.equal(noToken.calls.length, 0);
});

test('invalid base URLs and tuning options fail early', () => {
  for (const baseUrl of ['file:///local/path', 'https://username:password@example.com', 'https://example.com/?token=abc']) {
    assert.throws(() => harness([], { baseUrl }), ScopehatchConfigurationError);
  }
  assert.throws(() => harness([], { maxRetries: 8 }), ScopehatchConfigurationError);
  assert.throws(() => harness([], { timeoutMs: 0 }), ScopehatchConfigurationError);
});

test('suggestions remain drafts, with explicit idempotency', async () => {
  const suggestion = { suggestion: { deliverables: [] }, provenance: [], model: 'fixture', usage: { status: 'unknown' } };
  const { client, calls } = harness([json(suggestion)]);
  assert.deepEqual(await client.suggestScope('p', {}, write('suggest-1')), suggestion);
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'suggest-1');
});
