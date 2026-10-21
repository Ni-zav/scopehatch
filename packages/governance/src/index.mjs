import { createHash } from 'node:crypto';

const MAX_AMOUNT = 10n ** 30n;
const MAX_TOKENS = 1_000_000_000;
const MILLION = 1_000_000n;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export class GovernanceError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) { throw new GovernanceError(code, message, status); }
function ident(v, name) { if (typeof v !== 'string' || !IDENTIFIER.test(v)) fail('INVALID_INPUT', `Invalid ${name}`); return v; }
function count(v, name, allowZero = true) {
  if (!Number.isSafeInteger(v) || v < (allowZero ? 0 : 1) || v > MAX_TOKENS) fail('INVALID_INPUT', `Invalid ${name}`);
  return v;
}
export function amount(value, name = 'amount') {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,29})$/.test(value)) fail('INVALID_AMOUNT', `Invalid ${name}`);
  const parsed = BigInt(value);
  if (parsed > MAX_AMOUNT) fail('INVALID_AMOUNT', `Excessive ${name}`);
  return parsed;
}
function asAmount(v) { if (v < 0n || v > MAX_AMOUNT) fail('AMOUNT_OVERFLOW', 'Monetary limit exceeded'); return String(v); }
function currency(v) { if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) fail('INVALID_CURRENCY', 'Invalid currency'); return v; }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function allowedRoute(policy, candidate) {
  return Array.isArray(policy.allowedModels) && policy.allowedModels.some(m => m.providerId === candidate.providerId && m.model === candidate.model);
}

/** Pure routing: candidate entries must be sourced from a trusted tenant-scoped registry. */
export function eligibleProviders({ tenantId, policy, candidates, capability, inputTokens, outputTokens, residency, circuit }) {
  ident(tenantId, 'tenantId'); ident(capability, 'capability');
  count(inputTokens, 'inputTokens'); count(outputTokens, 'outputTokens');
  if (policy?.tenantId !== tenantId || !Array.isArray(candidates) || !Array.isArray(policy.allowedModels)) fail('POLICY_MISMATCH', 'Tenant policy unavailable', 403);
  const result = [];
  for (const p of candidates) {
    if (p.tenantId !== tenantId || !p.enabled || !allowedRoute(policy, p)) continue;
    if (!Array.isArray(p.capabilities) || !p.capabilities.includes(capability)) continue;
    if (!Number.isSafeInteger(p.contextWindow) || p.contextWindow < inputTokens + outputTokens) continue;
    if (residency && p.residency !== residency) continue;
    if (Array.isArray(policy.allowedResidencies) && !policy.allowedResidencies.includes(p.residency)) continue;
    if (circuit && !circuit.canRequest(tenantId, p.providerId, p.model)) continue;
    if (p.currency !== policy.currency || !p.price || !p.providerId || !p.model) continue;
    try {
      ident(p.providerId, 'providerId'); ident(p.model, 'model');
      amount(p.price.inputPerMillionMinor); amount(p.price.outputPerMillionMinor);
      currency(p.currency);
    } catch { continue; }
    result.push({ tenantId, providerId: p.providerId, model: p.model, residency: p.residency,
      currency: p.currency, price: { ...p.price }, priority: Number.isSafeInteger(p.priority) ? p.priority : 100,
      timeoutMs: Number.isSafeInteger(p.timeoutMs) && p.timeoutMs >= 1 && p.timeoutMs <= 120_000 ? p.timeoutMs : 15_000 });
  }
  result.sort((a, b) => a.priority - b.priority || a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model));
  return result;
}

/** Round the aggregate token charges up once to currency minor units, using bigint only. */
export function tokenCostMinor(price, usage) {
  const inTokens = count(usage.inputTokens, 'inputTokens');
  const outTokens = count(usage.outputTokens, 'outputTokens');
  const total = BigInt(inTokens) * amount(price.inputPerMillionMinor) + BigInt(outTokens) * amount(price.outputPerMillionMinor);
  return asAmount((total + MILLION - 1n) / MILLION);
}

function requireTenant(tenantId) { return ident(tenantId, 'tenantId'); }
async function readAccount(tx, expectedCurrency) {
  const a = await tx.getAccount();
  if (!a) fail('BUDGET_NOT_CONFIGURED', 'Budget not configured', 503);
  if (currency(a.currency) !== expectedCurrency) fail('CURRENCY_MISMATCH', 'Budget currency mismatch', 409);
  const limit = amount(a.limitMinor, 'limitMinor'); const held = amount(a.heldMinor, 'heldMinor'); const spent = amount(a.spentMinor, 'spentMinor');
  if (held + spent > MAX_AMOUNT) fail('AMOUNT_OVERFLOW', 'Monetary limit exceeded');
  return { ...a, limit, held, spent };
}
function publicReservation(r) {
  return { id: r.id, tenantId: r.tenantId, status: r.status, providerId: r.providerId, model: r.model,
    currency: r.currency, reservedMinor: r.reservedMinor, costMinor: r.costMinor,
    usage: r.usage, dispatched: r.dispatched };
}
async function eventOnce(tx, tenantId, eventId, reservationId, kind, payload) {
  ident(eventId, 'eventId'); const fingerprint = digest({ tenantId, reservationId, kind, payload });
  const prior = await tx.getEvent(eventId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Event ID reused with different contents', 409);
    return true;
  }
  await tx.putEvent({ tenantId, id: eventId, reservationId, kind, fingerprint });
  return false;
}

/** All read/modify/write actions occur inside storage.withTenantTransaction. */
export class GovernanceEngine {
  constructor({ storage, circuit = new CircuitBreaker(), clock = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!storage || typeof storage.withTenantTransaction !== 'function') fail('INVALID_STORAGE', 'Transaction-capable storage required');
    this.storage = storage; this.circuit = circuit; this.clock = clock; this.sleep = sleep;
  }

  async reserve({ tenantId, idempotencyKey, requestDigest, policy, candidates, capability, inputTokens, outputTokens, residency }) {
    requireTenant(tenantId); ident(idempotencyKey, 'idempotencyKey');
    if (typeof requestDigest !== 'string' || !DIGEST.test(requestDigest)) fail('INVALID_INPUT', 'A canonical SHA-256 request digest is required');
    count(inputTokens, 'inputTokens'); count(outputTokens, 'outputTokens');
    const routes = eligibleProviders({ tenantId, policy, candidates, capability, inputTokens, outputTokens, residency, circuit: this.circuit });
    const intent = digest({ requestDigest, capability, inputTokens, outputTokens, residency: residency ?? null });
    return this.storage.withTenantTransaction(tenantId, async tx => {
      const previous = await tx.getReservationByKey(idempotencyKey);
      if (previous) {
        if (previous.intent !== intent) fail('IDEMPOTENCY_CONFLICT', 'Key reused for different request', 409);
        return { ...publicReservation(previous), replay: true };
      }
      if (!routes.length) fail('NO_ELIGIBLE_PROVIDER', 'No eligible provider for requested capability', 503);
      const account = await readAccount(tx, policy.currency);
      const choices = routes.map(r => ({ route: r, cost: amount(tokenCostMinor(r.price, { inputTokens, outputTokens })) }));
      const choice = choices.find(x => account.spent + account.held + x.cost <= account.limit);
      if (!choice) fail('QUOTA_EXCEEDED', 'Budget cannot cover reserved inference usage', 429);
      const r = choice.route; const held = asAmount(account.held + choice.cost);
      const reservation = { id: digest({ tenantId, idempotencyKey }), tenantId, idempotencyKey, intent,
        providerId: r.providerId, model: r.model, currency: r.currency, price: r.price,
        reservedMinor: String(choice.cost), costMinor: null, usage: { status: 'unknown' },
        status: 'reserved', dispatched: false, createdAt: this.clock() };
      await tx.putAccount({ ...account, limitMinor: String(account.limit), spentMinor: String(account.spent), heldMinor: held });
      await tx.putReservation(reservation);
      return { ...publicReservation(reservation), replay: false };
    });
  }

  async markDispatched({ tenantId, reservationId }) {
    requireTenant(tenantId); ident(reservationId, 'reservationId');
    return this.storage.withTenantTransaction(tenantId, async tx => {
      const r = await tx.getReservationById(reservationId);
      if (!r) fail('NOT_FOUND', 'Reservation not found', 404);
      if (r.status === 'dispatched') return publicReservation(r);
      if (r.status !== 'reserved') fail('INVALID_TRANSITION', 'Reservation cannot be dispatched', 409);
      const next = { ...r, status: 'dispatched', dispatched: true };
      await tx.putReservation(next); return publicReservation(next);
    });
  }

  /** Release only before dispatch, or with trusted explicit evidence that dispatch was not billed. */
  async release({ tenantId, reservationId, eventId, confirmedNotBilled = false }) {
    requireTenant(tenantId); ident(reservationId, 'reservationId');
    return this.storage.withTenantTransaction(tenantId, async tx => {
      const r = await tx.getReservationById(reservationId);
      if (!r) fail('NOT_FOUND', 'Reservation not found', 404);
      const replay = await eventOnce(tx, tenantId, eventId, reservationId, 'release', { confirmedNotBilled });
      if (replay) return { ...publicReservation(r), replay: true };
      if (r.status !== 'reserved' && !(confirmedNotBilled && r.status === 'dispatched')) fail('INVALID_TRANSITION', 'Cannot release potentially billable usage', 409);
      const a = await readAccount(tx, r.currency);
      await tx.putAccount({ ...a, limitMinor: String(a.limit), spentMinor: String(a.spent), heldMinor: asAmount(a.held - amount(r.reservedMinor)) });
      const next = { ...r, status: 'released', costMinor: confirmedNotBilled ? '0' : null };
      await tx.putReservation(next); return { ...publicReservation(next), replay: false };
    });
  }

  /** Unknown usage never releases a hold; reported usage replaces the hold with actual spend. */
  async settle({ tenantId, reservationId, eventId, usage }) {
    requireTenant(tenantId); ident(reservationId, 'reservationId');
    if (!usage || (usage.status !== 'reported' && usage.status !== 'unknown')) fail('INVALID_USAGE', 'Explicit usage status required');
    if (usage.status === 'reported') {
      count(usage.inputTokens, 'inputTokens'); count(usage.outputTokens, 'outputTokens');
    } else if (Object.keys(usage).some(k => k !== 'status')) fail('INVALID_USAGE', 'Unknown usage cannot contain assumed counts');
    return this.storage.withTenantTransaction(tenantId, async tx => {
      const r = await tx.getReservationById(reservationId);
      if (!r) fail('NOT_FOUND', 'Reservation not found', 404);
      if (await eventOnce(tx, tenantId, eventId, reservationId, 'settle', usage)) return { ...publicReservation(r), replay: true };
      if (r.status !== 'dispatched' && r.status !== 'unknown') fail('INVALID_TRANSITION', 'Reservation is not eligible for settlement', 409);
      if (usage.status === 'unknown') {
        const next = { ...r, status: 'unknown', usage: { status: 'unknown' }, costMinor: null };
        await tx.putReservation(next); return { ...publicReservation(next), replay: false };
      }
      const cost = amount(tokenCostMinor(r.price, usage)); const a = await readAccount(tx, r.currency);
      const next = { ...r, status: 'settled', costMinor: String(cost), usage: { status: 'reported', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
      await tx.putAccount({ ...a, limitMinor: String(a.limit), heldMinor: asAmount(a.held - amount(r.reservedMinor)), spentMinor: asAmount(a.spent + cost) });
      await tx.putReservation(next); return { ...publicReservation(next), replay: false };
    });
  }

  /** Trusted invoice reconciliation can prove actual cost despite absent token counts. */
  async reconcile({ tenantId, reservationId, eventId, billedCostMinor, evidenceRef }) {
    requireTenant(tenantId); ident(reservationId, 'reservationId'); ident(evidenceRef, 'evidenceRef');
    const cost = amount(billedCostMinor, 'billedCostMinor');
    return this.storage.withTenantTransaction(tenantId, async tx => {
      const r = await tx.getReservationById(reservationId);
      if (!r) fail('NOT_FOUND', 'Reservation not found', 404);
      if (await eventOnce(tx, tenantId, eventId, reservationId, 'reconcile', { billedCostMinor, evidenceRef })) return { ...publicReservation(r), replay: true };
      if (r.status !== 'unknown') fail('INVALID_TRANSITION', 'Only unknown usage may be reconciled', 409);
      const a = await readAccount(tx, r.currency);
      await tx.putAccount({ ...a, limitMinor: String(a.limit), heldMinor: asAmount(a.held - amount(r.reservedMinor)), spentMinor: asAmount(a.spent + cost) });
      const next = { ...r, status: 'settled', usage: { status: 'unknown' }, costMinor: String(cost), reconciliationEvidenceRef: evidenceRef };
      await tx.putReservation(next); return { ...publicReservation(next), replay: false };
    });
  }
}

/** Advisory per-process breaker, NOT a globally synchronized quota or circuit state. */
export class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 30_000, clock = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(threshold) || threshold < 1 || !Number.isSafeInteger(cooldownMs) || cooldownMs < 1) fail('INVALID_INPUT', 'Invalid breaker configuration');
    this.threshold = threshold; this.cooldownMs = cooldownMs; this.clock = clock; this.states = new Map();
  }
  key(t, p, m) { return JSON.stringify([t, p, m]); }
  canRequest(t, p, m) {
    const s = this.states.get(this.key(t, p, m));
    return !s || s.openedUntil <= this.clock();
  }
  success(t, p, m) { this.states.delete(this.key(t, p, m)); }
  failure(t, p, m) {
    const k = this.key(t, p, m); const s = this.states.get(k) ?? { failures: 0, openedUntil: 0 };
    const failures = s.openedUntil > 0 && s.openedUntil <= this.clock() ? 1 : s.failures + 1;
    this.states.set(k, { failures, openedUntil: failures >= this.threshold ? this.clock() + this.cooldownMs : 0 });
  }
}

/** Fixed safe trace schema: no prompt, response, raw error, keys or arbitrary metadata. */
export function safeTrace({ traceId, tenantId, providerId, model, status, attempts, latencyMs, usageStatus, costMinor }) {
  ident(traceId, 'traceId'); ident(tenantId, 'tenantId');
  const out = { traceId, tenantHash: createHash('sha256').update(tenantId).digest('hex').slice(0, 16) };
  if (providerId !== undefined) out.providerId = ident(providerId, 'providerId');
  if (model !== undefined) out.model = ident(model, 'model');
  if (['settled', 'unknown', 'released', 'failed'].includes(status)) out.status = status;
  if (Number.isSafeInteger(attempts) && attempts >= 0 && attempts <= 20) out.attempts = attempts;
  if (Number.isSafeInteger(latencyMs) && latencyMs >= 0 && latencyMs <= 86_400_000) out.latencyMs = latencyMs;
  if (usageStatus === 'reported' || usageStatus === 'unknown') out.usageStatus = usageStatus;
  if (costMinor !== undefined && costMinor !== null) out.costMinor = String(amount(costMinor));
  return Object.freeze(out);
}

function withTimeout(call, parentSignal, timeoutMs) {
  if (parentSignal?.aborted) return Promise.reject(new GovernanceError('CANCELLED', 'Inference cancelled', 499));
  const ctrl = new AbortController();
  let timer; let off;
  const cancellation = new Promise((_, reject) => {
    off = () => { ctrl.abort(); reject(new GovernanceError('CANCELLED', 'Inference cancelled', 499)); };
    parentSignal?.addEventListener('abort', off, { once: true });
    timer = setTimeout(() => { ctrl.abort(); reject(new GovernanceError('TIMEOUT', 'Provider deadline exceeded', 504)); }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => call(ctrl.signal)), cancellation])
    .finally(() => { clearTimeout(timer); parentSignal?.removeEventListener('abort', off); });
}

/** Callback is a trusted adapter: errors claiming nonBillable MUST be verified by that adapter. */
export async function executeGoverned({ engine, request, traceId, call, signal, maxAttempts = 2, retryDelayMs = 25 }) {
  ident(traceId, 'traceId');
  if (typeof call !== 'function' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 ||
      !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 2000) fail('INVALID_INPUT', 'Invalid execution options');
  const start = engine.clock();
  const reserved = await engine.reserve(request);
  if (reserved.replay) return { status: 'replayed', reservation: reserved };
  const routing = eligibleProviders({ ...request, circuit: engine.circuit }).find(r => r.providerId === reserved.providerId && r.model === reserved.model);
  if (!routing) fail('NO_ELIGIBLE_PROVIDER', 'Reserved route no longer eligible', 503);
  if (signal?.aborted) {
    await engine.release({ tenantId: request.tenantId, reservationId: reserved.id, eventId: `${reserved.id.slice(0,64)}:cancel` });
    throw new GovernanceError('CANCELLED', 'Inference cancelled', 499);
  }
  await engine.markDispatched({ tenantId: request.tenantId, reservationId: reserved.id });
  let lastError; let attempts = 0;
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) break;
    if (!engine.circuit.canRequest(request.tenantId, routing.providerId, routing.model)) break;
    attempts++;
    try {
      const answer = await withTimeout(s => call({ providerId: routing.providerId, model: routing.model, attempt: i + 1, signal: s, traceId }), signal, routing.timeoutMs);
      if (!answer || typeof answer !== 'object') throw new Error('Invalid adapter response');
      // Unreported, partial or malformed token metering is UNKNOWN, never zero.
      const usage = answer.usage?.status === 'reported' && Number.isSafeInteger(answer.usage.inputTokens) &&
        Number.isSafeInteger(answer.usage.outputTokens) && answer.usage.inputTokens >= 0 &&
        answer.usage.outputTokens >= 0 && answer.usage.inputTokens <= MAX_TOKENS &&
        answer.usage.outputTokens <= MAX_TOKENS
        ? { status: 'reported', inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens }
        : { status: 'unknown' };
      const settlement = await engine.settle({ tenantId: request.tenantId, reservationId: reserved.id, eventId: `${reserved.id.slice(0,64)}:success`, usage });
      engine.circuit.success(request.tenantId, routing.providerId, routing.model);
      return { status: settlement.status, value: answer.value, reservation: settlement,
        trace: safeTrace({ traceId, tenantId: request.tenantId, providerId: routing.providerId, model: routing.model,
          status: settlement.status, attempts, latencyMs: Math.max(0, engine.clock() - start), usageStatus: settlement.usage.status,
          costMinor: settlement.costMinor }) };
    } catch (error) {
      // A storage failure must not be mistaken for a transient provider error.
      if (error instanceof GovernanceError && !['TIMEOUT', 'CANCELLED'].includes(error.code)) throw error;
      lastError = error;
      engine.circuit.failure(request.tenantId, routing.providerId, routing.model);
      if (error?.nonBillable === true && error?.retryable === true && i + 1 < maxAttempts && !signal?.aborted &&
          engine.circuit.canRequest(request.tenantId, routing.providerId, routing.model)) {
        await engine.sleep(Math.min(2000, retryDelayMs * 2 ** i));
        continue;
      }
      break;
    }
  }
  // Only a trusted explicit non-billed outcome may release funds after dispatch.
  if (lastError?.nonBillable === true && !signal?.aborted) {
    await engine.release({ tenantId: request.tenantId, reservationId: reserved.id, eventId: `${reserved.id.slice(0,64)}:notbilled`, confirmedNotBilled: true });
  } else {
    await engine.settle({ tenantId: request.tenantId, reservationId: reserved.id, eventId: `${reserved.id.slice(0,64)}:unknown`, usage: { status: 'unknown' } });
  }
  throw new GovernanceError(signal?.aborted ? 'CANCELLED' : lastError?.code === 'TIMEOUT' ? 'TIMEOUT' : 'PROVIDER_FAILED', 'Provider call did not complete; accounting retained when uncertain', signal?.aborted ? 499 : 503);
}
