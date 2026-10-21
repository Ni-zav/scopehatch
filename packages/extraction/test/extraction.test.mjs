import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExtractor, createFixtureProvider, createOpenAICompatibleProvider,
  ExtractionError, extractBrief, LIMITS, validateCompletion
} from '../index.mjs';
import { golden } from '../fixtures/golden.mjs';
import { evaluateFixtures } from '../evaluate.mjs';

const serviceCatalog = golden[0].catalog;
const context = { tenantId: 'tenant-a' };
const input = row => ({ brief: row.brief, serviceCatalog, requestId: row.requestId });
const fixture = createFixtureProvider({ cases: golden });
const extractor = createExtractor({ provider: fixture });

async function rejects(promise, code) {
  await assert.rejects(promise, err => err instanceof ExtractionError && err.code === code);
}

function fake(output, extras = {}) {
  return { name: 'mock', model: 'deterministic',
    async complete() { return { content: JSON.stringify(output), ...extras }; } };
}
const brief = 'Please produce 3 exterior images.';
const valid = { suggestedDeliverables: [{ serviceId: 'exterior-render', quantity: 3,
  evidence: { start: 15, end: 32, quote: '3 exterior images' } }], unknowns: ['deadline'] };
const goodInput = { brief, serviceCatalog, requestId: 'r-1' };

test('exact UTF-16 offsets, null quantity, metadata and unknown usage', async () => {
  const a = await extractor.extractBrief(input(golden[0]), context);
  assert.equal(a.suggestedDeliverables[0].quantity, 12);
  assert.equal(a.provenance.offsetEncoding, 'utf16');
  assert.equal(a.usage.status, 'unknown');
  const b = await extractor.extractBrief(input(golden[1]), context);
  assert.equal(b.suggestedDeliverables[0].quantity, null);
  assert.equal(b.suggestedDeliverables[0].evidence.quote, 'render the new office');
  assert.ok(Object.isFrozen(a.suggestedDeliverables));
});

test('all synthetic fixture scenarios replay; never grant price or approval', async () => {
  for (const row of golden) {
    const result = await extractor.extractBrief(input(row), context);
    assert.deepEqual(result.suggestedDeliverables.map(d => d.serviceId), row.expected.ids);
    assert.deepEqual(result.suggestedDeliverables.map(d => d.quantity), row.expected.quantities);
    assert.ok(result.unknowns.length > 0);
    for (const forbidden of ['price', 'unitPriceMinor', 'approval', 'approvedBy', 'tenantId', 'roles'])
      assert.equal(Object.hasOwn(result, forbidden), false);
  }
  const summary = await evaluateFixtures();
  assert.equal(summary.cases, golden.length);
  assert.equal(summary.counts.falseCommitment, 0);
  assert.match(summary.methodology, /not live-model/);
});

test('rejects unknown IDs, forbidden authority fields, quantities and fabricated evidence', async () => {
  for (const mutation of [
    { ...valid, suggestedDeliverables: [{ ...valid.suggestedDeliverables[0], serviceId: 'arbitrary' }] },
    { ...valid, price: 1 }, { ...valid, approvedBy: 'model' },
    { ...valid, suggestedDeliverables: [{ ...valid.suggestedDeliverables[0], quantity: 0 }] },
    { ...valid, suggestedDeliverables: [{ ...valid.suggestedDeliverables[0], quantity: 900 }] },
    { ...valid, suggestedDeliverables: [{ ...valid.suggestedDeliverables[0], evidence: null }] }
  ]) await assert.rejects(extractBrief(goodInput, context, fake(mutation)), ExtractionError);
  for (const ev of [
    { start: 15, end: 32, quote: '3 exterior imageZ' },
    { start: 0, end: 17, quote: 'Please produce 3' },
    { start: -1, end: 2, quote: 'P' },
    { start: 15, end: 999, quote: '3 exterior images' }
  ]) await assert.rejects(extractBrief(goodInput, context,
    fake({ ...valid, suggestedDeliverables: [{ ...valid.suggestedDeliverables[0], evidence: ev }] })), ExtractionError);
});

test('UTF-16 surrogate splitting rejects even if quote matches broken slice', () => {
  const unicode = '😀 3 exterior images';
  const completion = JSON.stringify({ suggestedDeliverables: [{ serviceId: 'exterior-render', quantity: null,
    evidence: { start: 1, end: 2, quote: unicode.slice(1, 2) } }], unknowns: [] });
  assert.throws(() => validateCompletion(completion, { brief: unicode, serviceCatalog }),
    e => e.code === 'UNVERIFIABLE_EVIDENCE');
});

test('bounded input/output and duplicate catalog IDs', async () => {
  await rejects(extractBrief({ ...goodInput, brief: 'X'.repeat(LIMITS.briefLength + 1) }, context, fake(valid)), 'INVALID_INPUT');
  await rejects(extractBrief({ ...goodInput, serviceCatalog: [serviceCatalog[0], serviceCatalog[0]] }, context, fake(valid)), 'INVALID_INPUT');
  await rejects(extractBrief(goodInput, context, { ...fake(valid),
    async complete() { return { content: 'X'.repeat(LIMITS.outputBytes + 1) }; } }), 'INVALID_MODEL_OUTPUT');
  await rejects(extractBrief(goodInput, context, fake({ ...valid, unknowns: ['a', 'a'] })), 'INVALID_MODEL_OUTPUT');
  await rejects(extractBrief(goodInput, context, fake({ ...valid, suggestedDeliverables: [{ ...valid.suggestedDeliverables[0], quantity: 1.5 }] })), 'INVALID_MODEL_OUTPUT');
});

test('timeouts, already aborted, in-flight cancellation and uncooperative providers', async () => {
  const slow = { name: 'slow', model: 'slow', complete: () => new Promise(() => {}) };
  await rejects(extractBrief(goodInput, context, slow, { timeoutMs: 10 }), 'TIMEOUT');
  const already = new AbortController(); already.abort();
  await rejects(extractBrief(goodInput, { ...context, signal: already.signal }, slow), 'CANCELLED');
  const controller = new AbortController();
  const promise = extractBrief(goodInput, { ...context, signal: controller.signal }, slow, { timeoutMs: 1000 });
  controller.abort();
  await rejects(promise, 'CANCELLED');
});

test('redacted provider failure states', async () => {
  await rejects(extractBrief(goodInput, context, { name: 'bad', model: 'bad',
    complete() { throw new Error('API_KEY_SECRET and client private brief'); } }), 'PROVIDER_FAILURE');
  try { await extractBrief(goodInput, context, { name: 'bad', model: 'bad',
      complete() { throw new Error('API_KEY_SECRET and client private brief'); } }); }
  catch (error) {
    assert.doesNotMatch(JSON.stringify(error), /API_KEY_SECRET|private brief/);
    assert.equal(error.requestId, 'r-1');
  }
});

test('OpenAI-compatible wire, no tenant/prices forwarded; reported usage', async () => {
  let called = 0;
  const provider = createOpenAICompatibleProvider({
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
    allowedHosts: ['127.0.0.1'], model: 'local-model', provider: 'ollama',
    fetchImpl: async (_url, req) => {
      called += 1;
      assert.equal(req.redirect, 'error');
      const msg = JSON.parse(req.body).messages;
      const prompt = msg.map(m => m.content).join(' ');
      assert.doesNotMatch(prompt, /tenant-a|unitPriceMinor|99secret/);
      assert.match(prompt, /3 exterior images/);
      return new Response(JSON.stringify({ model: 'local-model-q4',
        choices: [{ message: { content: JSON.stringify(valid) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 33 } }), { status: 200 });
    }
  });
  const result = await extractBrief({ ...goodInput, serviceCatalog: serviceCatalog.map(s => ({ ...s, unitPriceMinor: 99, apiKey: '99secret' })) }, context, provider);
  assert.equal(called, 1);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 33, status: 'reported' });
  assert.equal(result.modelMetadata.reportedModel, 'local-model-q4');
});

test('provider HTTP 401,429,503, malformed/truncated envelope, unknown token usage', async () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH'], [429, 'PROVIDER_RATE_LIMITED'], [503, 'PROVIDER_UNAVAILABLE']]) {
    const p = createOpenAICompatibleProvider({ endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'test', allowedHosts: ['api.openai.com'], apiKey: 'very-secret',
      fetchImpl: async () => new Response('secret error details', { status }) });
    await rejects(extractBrief(goodInput, context, p), code);
  }
  for (const body of ['invalid-json', JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) }, finish_reason: 'length' }] })]) {
    const p = createOpenAICompatibleProvider({ endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'test', allowedHosts: ['api.openai.com'], fetchImpl: async () => new Response(body) });
    await rejects(extractBrief(goodInput, context, p), 'PROVIDER_FAILURE');
  }
  const partial = createOpenAICompatibleProvider({ endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'test', allowedHosts: ['api.openai.com'],
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) }, finish_reason: 'stop' }], usage: { prompt_tokens: 2 } })) });
  const result = await extractBrief(goodInput, context, partial);
  assert.deepEqual(result.usage, { inputTokens: 2, status: 'unknown' });
});

test('endpoint allowlist blocks untrusted hosts, redirects and cleartext remote URLs', async () => {
  for (const endpoint of ['http://169.254.169.254/v1/chat/completions', 'https://evil.test/v1/chat/completions',
    'https://api.openai.com@evil.test/v1/chat/completions', 'https://api.openai.com/v1/chat/completions?key=secret']) {
    assert.throws(() => createOpenAICompatibleProvider({ endpoint, model: 'test', allowedHosts: ['api.openai.com'] }),
      e => e.code === 'INVALID_PROVIDER_CONFIG');
  }
  const p = createOpenAICompatibleProvider({ endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'test', allowedHosts: ['api.openai.com'],
    fetchImpl: async () => { throw new TypeError('redirect disallowed'); } });
  await rejects(extractBrief(goodInput, context, p), 'PROVIDER_UNAVAILABLE');
});

test('oversized streamed response terminates before JSON parse', async () => {
  const p = createOpenAICompatibleProvider({ endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'test', allowedHosts: ['api.openai.com'],
    fetchImpl: async () => new Response('X'.repeat(LIMITS.outputBytes + 4097)) });
  await rejects(extractBrief(goodInput, context, p), 'OUTPUT_TOO_LARGE');
});

test('fixture mismatch is explicit; model cannot swap tenants', async () => {
  await rejects(extractBrief({ ...input(golden[0]), brief: 'different' }, context, fixture), 'FIXTURE_NOT_FOUND');
  const outcome = await extractor.extractBrief(input(golden[0]), { tenantId: 'tenant-b' });
  assert.equal(Object.hasOwn(outcome, 'tenantId'), false);
});
