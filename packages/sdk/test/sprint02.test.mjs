import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ScopehatchClient, staticBearerToken, ScopehatchHttpError, ScopehatchProtocolError,
  ScopehatchConfigurationError, ScopehatchTimeoutError, ScopehatchAbortError,
} from '../dist/src/index.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
const problem = (status, code) => json({
  error: { code, message: 'Internal detail omitted', requestId: 's02-request' },
}, status);
function setup(responses, options = {}) {
  const calls = [];
  const client = new ScopehatchClient({
    baseUrl: 'https://example.invalid', credentials: staticBearerToken('signed-by-fixture'),
    maxRetries: 2, retryDelayMs: 0, maxRetryDelayMs: 0,
    fetch: async (url, init) => {
      calls.push({ url: new URL(url), init });
      const item = responses.shift();
      assert.ok(item, 'unexpected HTTP request');
      return typeof item === 'function' ? item(url, init) : item;
    }, ...options,
  });
  return { client, calls };
}
const catalogInput = {
  baseVersion: 0, currency: 'USD', services: [
    { id: 'exterior', label: 'Exterior views', unitPriceMinor: 0 },
    { id: 'interior', label: 'Interiors', unitPriceMinor: 2500 },
  ],
};
const catalog = { tenantId: 'fixture-tenant', currency: 'USD', version: 1,
  services: catalogInput.services };
const listing = {
  items: [{ id: 'p2', title: 'New studio brief', status: 'approved',
    createdAt: '2026-10-22T01:10:00.000Z' }],
  nextCursor: 'opaque_cursor-123',
};
test('owner catalog creation is a complete CAS write with an explicit key; no role/tenant override', async () => {
  const { client, calls } = setup([json({ catalog }, 201)]);
  const result = await client.createCatalog({
    ...catalogInput, actorId: 'forged', tenantId: 'other',
    services: catalogInput.services.map(s => ({ ...s, actorRole: 'owner', state: 'approved' })),
  }, { idempotencyKey: 'catalog-1' });
  assert.deepEqual(result, catalog);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/v1/catalogs');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'catalog-1');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer signed-by-fixture');
  assert.deepEqual(JSON.parse(calls[0].init.body), catalogInput);
  assert.equal(calls[0].init.headers['X-Workspace-Id'], undefined);
});
test('project pagination preserves cursor and order; never transmits a tenant filter', async () => {
  const { client, calls } = setup([
    json({ ...listing, items: [{ ...listing.items[0], brief: 'should not appear', tenantId: 'internal' }] }),
    json({ items: [{ id: 'p1', title: 'Old', status: 'draft',
      createdAt: '2026-10-21T01:10:00Z' }], nextCursor: null }),
    json({ items: [], nextCursor: null }),
  ], { workspaceId: 'selected-by-membership' });
  const first = await client.listProjects({ limit: 1 });
  assert.deepEqual(first, listing);
  const second = await client.listProjects({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].id, 'p1');
  assert.deepEqual(await client.listProjects(), { items: [], nextCursor: null });
  assert.equal(calls[1].url.searchParams.get('cursor'), listing.nextCursor);
  assert.equal(calls[1].url.searchParams.get('limit'), '1');
  assert.equal(calls[0].url.searchParams.get('tenantId'), null);
  assert.equal(calls[0].init.headers['X-Workspace-Id'], 'selected-by-membership');
  assert.equal(calls[0].init.headers['Idempotency-Key'], undefined);
});
test('scope metadata is forwarded in a new immutable revision without privileged extras', async () => {
  const input = {
    deliverables: [{ serviceId: 'exterior', quantity: 2, evidence: 'brief excerpt',
      source: 'brief', clientDescription: '<b>Sunset</b>', unitPriceMinor: 9999 }],
    unknowns: [],
    proposal: { overview: 'Project & text', assumptions: [' client supplies CAD '],
      exclusions: ['No animation'], commercialTerms: ['Written terms only'],
      totalMinor: 42, approvedBy: 'forged' }, tenantId: 'forged',
  };
  const { client, calls } = setup([json({ scope: { revision: 2 } }, 201), json({ scope: { revision: 3 } }, 201)]);
  assert.equal((await client.createScope('p', input, { idempotencyKey: 'scope-2' })).revision, 2);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    deliverables: [{ serviceId: 'exterior', quantity: 2, evidence: 'brief excerpt',
      source: 'brief', clientDescription: '<b>Sunset</b>' }],
    unknowns: [],
    proposal: { overview: 'Project & text', assumptions: ['client supplies CAD'],
      exclusions: ['No animation'], commercialTerms: ['Written terms only'] },
  });
  assert.equal((await client.createScope('p', {
    deliverables: [{ serviceId: 'exterior', quantity: null, evidence: '', source: 'manual' }],
    unknowns: [],
  }, { idempotencyKey: 'scope-old' })).revision, 3);
  assert.equal(JSON.parse(calls[1].init.body).proposal, undefined);
  assert.equal(JSON.parse(calls[1].init.body).deliverables[0].clientDescription, undefined);
});
test('invalid new request shapes fail before a network call', async () => {
  const { client, calls } = setup([]);
  const invalidCatalogs = [
    { ...catalogInput, baseVersion: -1 }, { ...catalogInput, currency: 'usd' },
    { ...catalogInput, currency: 'ZZZ' }, { ...catalogInput, services: [] },
    { ...catalogInput, services: [catalogInput.services[0], catalogInput.services[0]] },
    { ...catalogInput, services: [{ id: 'x', label: 'X', unitPriceMinor: -1 }] },
    { ...catalogInput, services: [{ id: 'x', label: 'X', unitPriceMinor: 1.5 }] },
  ];
  for (const input of invalidCatalogs) {
    await assert.rejects(client.createCatalog(input, { idempotencyKey: 'valid' }), ScopehatchConfigurationError);
  }
  await assert.rejects(client.createCatalog(catalogInput), ScopehatchConfigurationError);
  await assert.rejects(client.listProjects({ limit: 0 }), ScopehatchConfigurationError);
  await assert.rejects(client.listProjects({ limit: 101 }), ScopehatchConfigurationError);
  await assert.rejects(client.listProjects({ cursor: 'invalid&tenant=other' }), ScopehatchConfigurationError);
  await assert.rejects(client.listProjects({ cursor: 'x'.repeat(513) }), ScopehatchConfigurationError);
  for (const proposal of [
    { overview: 'x'.repeat(4001), assumptions: [], exclusions: [], commercialTerms: [] },
    { overview: '', assumptions: [' '], exclusions: [], commercialTerms: [] },
    { overview: '', assumptions: [], exclusions: [], commercialTerms: ['x'.repeat(2001)] },
    { overview: '', assumptions: Array(51).fill('term'), exclusions: [], commercialTerms: [] },
  ]) await assert.rejects(client.createScope('p', { deliverables: [], unknowns: [], proposal },
    { idempotencyKey: 'scope-x' }), ScopehatchConfigurationError);
  await assert.rejects(client.createScope('p', {
    unknowns: [], deliverables: [{ serviceId: 'a', quantity: 1, evidence: '',
      source: 'manual', clientDescription: 'x'.repeat(2001) }],
  }, { idempotencyKey: 'too-long' }), ScopehatchConfigurationError);
  assert.equal(calls.length, 0);
});
test('new endpoints reject malformed success bodies rather than trusting malformed JSON fields', async () => {
  const malformedPages = [
    {}, { items: [], nextCursor: 0 }, { items: {}, nextCursor: null },
    { items: [ { id: 'x', title: 'X', status: 'exported', createdAt: '2026-10-22T01:01:00Z' } ], nextCursor: null },
    { items: [ { id: 'x', title: 'X', status: 'ready', createdAt: 'yesterday' } ], nextCursor: null },
  ];
  const { client } = setup(malformedPages.map(json));
  for (const _ of malformedPages) await assert.rejects(client.listProjects(), ScopehatchProtocolError);
  const brokenCatalogs = [
    {}, { catalog: null }, { catalog: { ...catalog, version: 0 } },
    { catalog: { ...catalog, services: [{ id: 'foo', label: 'Bad', unitPriceMinor: -2 }] } },
  ];
  const other = setup(brokenCatalogs.map(x => json(x, 201)));
  for (const _ of brokenCatalogs) await assert.rejects(
    other.client.createCatalog(catalogInput, { idempotencyKey: 'fresh-for-test' }),
    ScopehatchProtocolError);
});
test('401/403/404/409/422 are typed and never retried; 503 writes retry only by explicit opt-in', async () => {
  for (const [status, code] of [[401,'UNAUTHENTICATED'],[403,'FORBIDDEN'],[404,'NOT_FOUND'],
    [409,'STALE_CATALOG_VERSION'],[422,'DUPLICATE_SERVICE']]) {
    const { client, calls } = setup([problem(status, code)]);
    await assert.rejects(client.createCatalog(catalogInput, { idempotencyKey: 'catalog-fail' }), e => {
      assert.ok(e instanceof ScopehatchHttpError);
      assert.equal(e.status, status);
      assert.equal(e.code, code);
      assert.equal(e.requestId, 's02-request');
      assert.doesNotMatch(e.message, /Internal detail/);
      return true;
    });
    assert.equal(calls.length, 1);
  }
  const failed = setup([problem(503, 'DEPENDENCY_UNAVAILABLE')]);
  await assert.rejects(failed.client.createCatalog(catalogInput, { idempotencyKey: 'write-1' }),
    ScopehatchHttpError);
  assert.equal(failed.calls.length, 1);
  const replay = setup([problem(503, 'DEPENDENCY_UNAVAILABLE'), json({ catalog }, 201)]);
  await replay.client.createCatalog(catalogInput, { idempotencyKey: 'write-1', retry: true });
  assert.equal(replay.calls.length, 2);
  assert.equal(replay.calls[0].init.body, replay.calls[1].init.body);
  assert.equal(replay.calls[0].init.headers['Idempotency-Key'], 'write-1');
  assert.equal(replay.calls[1].init.headers['Idempotency-Key'], 'write-1');
  const listDenied = setup([problem(404, 'NOT_FOUND')]);
  await assert.rejects(listDenied.client.listProjects(), e => e instanceof ScopehatchHttpError && e.status === 404);
  assert.equal(listDenied.calls.length, 1);
});
test('project-list caller cancellation and catalog write timeout are typed and propagated', async () => {
  const controller = new AbortController();
  let seenSignal;
  const read = setup([(_url, init) => { seenSignal = init.signal; return new Promise(() => {}); }]);
  const pending = read.client.listProjects({ signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, ScopehatchAbortError);
  assert.equal(seenSignal.aborted, true);
  const write = setup([() => new Promise(() => {})], { timeoutMs: 10, maxRetries: 0 });
  await assert.rejects(write.client.createCatalog(catalogInput, { idempotencyKey: 'timeout-1' }),
    ScopehatchTimeoutError);
  assert.equal(write.calls.length, 1);
});
