import test from 'node:test';
import assert from 'node:assert/strict';
import { GovernanceEngine, GovernanceError, CircuitBreaker, eligibleProviders, tokenCostMinor, safeTrace, executeGoverned } from '../src/index.mjs';
import { FakeGovernanceStore } from '../src/memory-store.mjs';

const prices = { inputPerMillionMinor: '1000000', outputPerMillionMinor: '1000000' };
const policy = tenantId => ({ tenantId, currency: 'USD', allowedModels: [{ providerId: 'local', model: 'model-1' }], allowedResidencies: ['local'] });
const providers = tenantId => [{ tenantId, providerId: 'local', model: 'model-1', enabled: true,
  capabilities: ['extraction'], contextWindow: 4096, residency: 'local', currency: 'USD', price: prices, priority: 1, timeoutMs: 20 }];
const request = (tenantId = 'A', key = 'one', inputTokens = 6, outputTokens = 4) => ({ tenantId, idempotencyKey: key,
  requestDigest: 'a'.repeat(64), policy: policy(tenantId), candidates: providers(tenantId), capability: 'extraction', inputTokens, outputTokens, residency: 'local' });
function setup(limitMinor = '20') { const storage = new FakeGovernanceStore(); storage.setAccount('A', { limitMinor });
  storage.setAccount('B', { limitMinor }); return { storage, engine: new GovernanceEngine({ storage, sleep: async () => {} }) }; }
const err = code => e => e instanceof GovernanceError && e.code === code;

test('precise aggregate pricing rounds up once, rejects decimals and unsafe arithmetic', () => {
  assert.equal(tokenCostMinor({ inputPerMillionMinor: '1', outputPerMillionMinor: '1' }, { inputTokens: 1, outputTokens: 1 }), '1');
  assert.equal(tokenCostMinor(prices, { inputTokens: 6, outputTokens: 4 }), '10');
  assert.throws(() => tokenCostMinor({ ...prices, inputPerMillionMinor: '0.5' }, { inputTokens: 1, outputTokens: 1 }), err('INVALID_AMOUNT'));
  assert.throws(() => tokenCostMinor(prices, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }), err('INVALID_INPUT'));
});

test('routing rejects other tenants, wrong residency, capabilities, context, and disabled models', () => {
  const r = request();
  assert.equal(eligibleProviders(r).length, 1);
  assert.equal(eligibleProviders({ ...r, capability: 'summarization' }).length, 0);
  assert.equal(eligibleProviders({ ...r, residency: 'EU' }).length, 0);
  assert.equal(eligibleProviders({ ...r, candidates: providers('B') }).length, 0);
  assert.equal(eligibleProviders({ ...r, inputTokens: 4090, outputTokens: 20 }).length, 0);
  assert.equal(eligibleProviders({ ...r, policy: { ...policy('A'), allowedModels: [] } }).length, 0);
  assert.throws(() => eligibleProviders({ ...r, policy: policy('B') }), err('POLICY_MISMATCH'));
});

test('no eligible provider and exhausted quota are explicit and do not allocate', async () => {
  const { engine, storage } = setup('9');
  await assert.rejects(() => engine.reserve(request()), err('QUOTA_EXCEEDED'));
  await assert.rejects(() => engine.reserve({ ...request(), capability: 'other' }), err('NO_ELIGIBLE_PROVIDER'));
  assert.equal(storage.snapshot('A').account.heldMinor, '0');
});

test('parallel reservers and duplicates do not double hold, quota or spend in fake store', async () => {
  const { engine, storage } = setup('10');
  const calls = Array.from({ length: 24 }, (_, i) => engine.reserve(request('A', i % 2 === 0 ? 'same' : `other-${i}`)));
  const settled = await Promise.allSettled(calls);
  const ok = settled.filter(x => x.status === 'fulfilled');
  assert.ok(ok.length >= 1);
  assert.equal(new Set(ok.map(x => x.value.id)).size, 1);
  assert.equal(storage.snapshot('A').account.heldMinor, '10');
  assert.equal(storage.snapshot('A').reservations.length, 1);
  assert.ok(settled.some(x => x.status === 'rejected' && x.reason.code === 'QUOTA_EXCEEDED'));
});

test('idempotency rejects conflicting request digest and preserves replay', async () => {
  const { engine } = setup(); const first = await engine.reserve(request());
  assert.equal(first.replay, false);
  assert.equal((await engine.reserve(request())).replay, true);
  await assert.rejects(() => engine.reserve({ ...request(), requestDigest: 'b'.repeat(64) }), err('IDEMPOTENCY_CONFLICT'));
});

test('unknown usage retains budget hold, supports late token reconciliation', async () => {
  const { engine, storage } = setup(); const r = await engine.reserve(request());
  await engine.markDispatched({ tenantId: 'A', reservationId: r.id });
  const unknown = await engine.settle({ tenantId: 'A', reservationId: r.id, eventId: 'evt-1', usage: { status: 'unknown' } });
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.usage.status, 'unknown'); assert.equal(unknown.costMinor, null);
  assert.deepEqual([storage.snapshot('A').account.heldMinor, storage.snapshot('A').account.spentMinor], ['10','0']);
  const known = await engine.settle({ tenantId: 'A', reservationId: r.id, eventId: 'evt-2', usage: { status: 'reported', inputTokens: 3, outputTokens: 2 } });
  assert.equal(known.costMinor, '5');
  assert.deepEqual([storage.snapshot('A').account.heldMinor, storage.snapshot('A').account.spentMinor], ['0','5']);
  assert.equal((await engine.settle({ tenantId: 'A', reservationId: r.id, eventId: 'evt-2', usage: { status: 'reported', inputTokens: 3, outputTokens: 2 } })).replay, true);
  await assert.rejects(() => engine.settle({ tenantId: 'A', reservationId: r.id, eventId: 'evt-2', usage: { status: 'reported', inputTokens: 6, outputTokens: 4 } }), err('IDEMPOTENCY_CONFLICT'));
});

test('invoice reconciliation preserves unknown token count and records verified billed cost', async () => {
  const { engine, storage } = setup(); const r = await engine.reserve(request());
  await engine.markDispatched({ tenantId: 'A', reservationId: r.id });
  await engine.settle({ tenantId: 'A', reservationId: r.id, eventId: 'unknown-event', usage: { status: 'unknown' } });
  const settled = await engine.reconcile({ tenantId: 'A', reservationId: r.id, eventId: 'invoice-1', billedCostMinor: '14', evidenceRef: 'statement-24' });
  assert.equal(settled.usage.status, 'unknown'); assert.equal(settled.costMinor, '14');
  assert.equal(storage.snapshot('A').account.spentMinor, '14');
  assert.equal((await engine.reconcile({ tenantId: 'A', reservationId: r.id, eventId: 'invoice-1', billedCostMinor: '14', evidenceRef: 'statement-24' })).replay, true);
});

test('cross-tenant reads and mutations cannot act on reservations', async () => {
  const { engine, storage } = setup(); const r = await engine.reserve(request());
  await assert.rejects(() => engine.markDispatched({ tenantId: 'B', reservationId: r.id }), err('NOT_FOUND'));
  await assert.rejects(() => engine.release({ tenantId: 'B', reservationId: r.id, eventId: 'bad' }), err('NOT_FOUND'));
  await assert.rejects(() => engine.settle({ tenantId: 'B', reservationId: r.id, eventId: 'bad2', usage: { status: 'unknown' } }), err('NOT_FOUND'));
  assert.equal(storage.snapshot('A').account.heldMinor, '10'); assert.equal(storage.snapshot('B').account.heldMinor, '0');
});

test('release is forbidden after dispatch without trusted nonbillable evidence', async () => {
  const { engine, storage } = setup(); const r = await engine.reserve(request());
  await engine.markDispatched({ tenantId: 'A', reservationId: r.id });
  await assert.rejects(() => engine.release({ tenantId: 'A', reservationId: r.id, eventId: 'attempt' }), err('INVALID_TRANSITION'));
  assert.equal(storage.snapshot('A').account.heldMinor, '10');
  const released = await engine.release({ tenantId: 'A', reservationId: r.id, eventId: 'verified', confirmedNotBilled: true });
  assert.equal(released.status, 'released'); assert.equal(storage.snapshot('A').account.heldMinor, '0');
});

test('failed settlement rolls back writes and retains hold for later reconciliation', async () => {
  const { storage } = setup(); const engine = new GovernanceEngine({ storage });
  const r = await engine.reserve(request()); await engine.markDispatched({ tenantId: 'A', reservationId: r.id });
  const original = storage.withTenantTransaction.bind(storage); let inject = true;
  storage.withTenantTransaction = (tenant, fn) => original(tenant, tx => fn({ ...tx, putAccount: a => { if (inject) { inject = false; throw Error('database unavailable'); } tx.putAccount(a); } }));
  await assert.rejects(() => engine.settle({ tenantId: 'A', reservationId: r.id, eventId: 'settle-fail', usage: { status: 'reported', inputTokens: 2, outputTokens: 2 } }), /database unavailable/);
  assert.equal(storage.snapshot('A').account.heldMinor, '10'); assert.equal(storage.snapshot('A').events.length, 0);
  const recovered = await engine.settle({ tenantId: 'A', reservationId: r.id, eventId: 'settle-fail', usage: { status: 'reported', inputTokens: 2, outputTokens: 2 } });
  assert.equal(recovered.costMinor, '4');
});

test('retry storm bounded by max attempts and breaker, no extra reservations', async () => {
  const { storage } = setup(); const breaker = new CircuitBreaker({ threshold: 2 });
  const engine = new GovernanceEngine({ storage, circuit: breaker, sleep: async () => {} });
  let calls = 0;
  await assert.rejects(() => executeGoverned({ engine, request: request(), traceId: 'retrytrace', maxAttempts: 3,
    call: async () => { calls++; throw Object.assign(new Error('down'), { retryable: true, nonBillable: true }); } }), err('PROVIDER_FAILED'));
  assert.equal(calls, 2); assert.equal(storage.snapshot('A').reservations.length, 1);
  assert.equal(storage.snapshot('A').account.heldMinor, '0');
  await assert.rejects(() => engine.reserve(request('A', 'next')), err('NO_ELIGIBLE_PROVIDER'));
});

test('cancellation before dispatch releases funds and during call retains unknown hold', async () => {
  const { engine, storage } = setup(); const early = new AbortController(); early.abort();
  await assert.rejects(() => executeGoverned({ engine, request: request('A', 'before'), traceId: 'before', signal: early.signal, call: async () => { throw Error('should not run'); } }), err('CANCELLED'));
  assert.equal(storage.snapshot('A').account.heldMinor, '0');
  const abort = new AbortController();
  await assert.rejects(() => executeGoverned({ engine, request: request('A', 'during'), traceId: 'during', signal: abort.signal,
    call: async () => { abort.abort(); return new Promise(() => {}); } }), err('CANCELLED'));
  assert.equal(storage.snapshot('A').account.heldMinor, '10');
  assert.equal(storage.snapshot('A').reservations.at(-1).status, 'unknown');
});

test('provider timeout does not cause blind retry and holds unknown usage', async () => {
  const { engine, storage } = setup(); let calls = 0;
  await assert.rejects(() => executeGoverned({ engine, request: request(), traceId: 'timeout', maxAttempts: 3,
    call: () => { calls++; return new Promise(() => {}); } }), err('TIMEOUT'));
  assert.equal(calls, 1); assert.equal(storage.snapshot('A').account.heldMinor, '10');
  assert.equal(storage.snapshot('A').reservations[0].usage.status, 'unknown');
});

test('reported provider response settles and trace excludes secrets/prompt', async () => {
  const { engine, storage } = setup();
  const outcome = await executeGoverned({ engine, request: request(), traceId: 'trace-1',
    call: async () => ({ value: { suggestion: 'draft' }, usage: { status: 'reported', inputTokens: 2, outputTokens: 3 } }) });
  assert.equal(outcome.status, 'settled'); assert.equal(outcome.reservation.costMinor, '5');
  assert.equal(storage.snapshot('A').account.spentMinor, '5');
  const trace = safeTrace({ traceId: 'abc', tenantId: 'A', providerId: 'local', model: 'model-1', status: 'settled',
    usageStatus: 'reported', costMinor: '5', apiKey: 'SECRET', prompt: 'PRIVATE', error: 'PRIVATE' });
  assert.ok(!JSON.stringify(trace).includes('SECRET') && !JSON.stringify(trace).includes('PRIVATE'));
  assert.ok(!Object.hasOwn(trace, 'tenantId'));
});

test('malformed reported usage fails closed and keeps hold', async () => {
  const { engine, storage } = setup(); const r = await engine.reserve(request());
  await engine.markDispatched({ tenantId: 'A', reservationId: r.id });
  await assert.rejects(() => engine.settle({ tenantId: 'A', reservationId: r.id, eventId: 'badusage', usage: { status: 'reported' } }), err('INVALID_INPUT'));
  await assert.rejects(() => engine.settle({ tenantId: 'A', reservationId: r.id, eventId: 'badusage', usage: { status: 'unknown', inputTokens: 0 } }), err('INVALID_USAGE'));
  assert.equal(storage.snapshot('A').account.heldMinor, '10');
});

test('provider omission or partial token counts settle as unknown, not zero', async () => {
  const { engine, storage } = setup();
  const result = await executeGoverned({ engine, request: request(), traceId: 'missingusage',
    call: async () => ({ value: { suggestion: 'draft' }, usage: { status: 'reported', inputTokens: 3 } }) });
  assert.equal(result.status, 'unknown'); assert.equal(result.reservation.costMinor, null);
  assert.equal(storage.snapshot('A').account.heldMinor, '10');
  assert.equal(storage.snapshot('A').account.spentMinor, '0');
});

test('negative, excess and non-integer token reports never settle as reported', async () => {
  for (const inputTokens of [-1, 3.2, '0', 1_000_000_001]) {
    const { engine, storage } = setup();
    const result = await executeGoverned({ engine, request: request(), traceId: 'badusage',
      call: async () => ({ value: 'draft', usage: { status: 'reported', inputTokens, outputTokens: 1 } }) });
    assert.equal(result.status, 'unknown'); assert.equal(storage.snapshot('A').account.heldMinor, '10');
  }
});

test('PostgreSQL-shaped awaited transaction methods are supported atomically', async () => {
  const { storage } = setup(); const original = storage.withTenantTransaction.bind(storage);
  storage.withTenantTransaction = (tenantId, fn) => original(tenantId, tx => fn({
    getAccount: async () => tx.getAccount(), putAccount: async a => tx.putAccount(a),
    getReservationByKey: async k => tx.getReservationByKey(k),
    getReservationById: async id => tx.getReservationById(id),
    putReservation: async r => tx.putReservation(r),
    getEvent: async id => tx.getEvent(id), putEvent: async e => tx.putEvent(e)
  }));
  const engine = new GovernanceEngine({ storage });
  const reservation = await engine.reserve(request());
  await engine.markDispatched({ tenantId: 'A', reservationId: reservation.id });
  const result = await engine.settle({ tenantId: 'A', reservationId: reservation.id, eventId: 'db-async',
    usage: { status: 'reported', inputTokens: 2, outputTokens: 2 } });
  assert.equal(result.costMinor, '4');
  assert.deepEqual([storage.snapshot('A').account.heldMinor, storage.snapshot('A').account.spentMinor], ['0', '4']);
});
