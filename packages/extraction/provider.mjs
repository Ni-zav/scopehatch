import { ExtractionError, fail } from './errors.mjs';
import { buildMessages } from './prompt.mjs';
import { LIMITS } from './validation.mjs';

function validateEndpoint(endpoint, allowedHosts) {
  let url;
  try { url = new URL(endpoint); } catch { fail('INVALID_PROVIDER_CONFIG', 'Invalid inference endpoint'); }
  if (url.username || url.password || url.hash || url.search ||
      !['https:', 'http:'].includes(url.protocol))
    fail('INVALID_PROVIDER_CONFIG', 'Inference endpoint must be a plain http(s) URL');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback)
    fail('INVALID_PROVIDER_CONFIG', 'Cleartext inference is allowed only on loopback');
  if (!Array.isArray(allowedHosts) || !allowedHosts.includes(url.hostname))
    fail('INVALID_PROVIDER_CONFIG', 'Inference host must be explicitly allowlisted');
  if (!url.pathname.endsWith('/chat/completions'))
    fail('INVALID_PROVIDER_CONFIG', 'Endpoint must point to /chat/completions');
  return url.href;
}

function safeUsage(raw) {
  const inputTokens = raw?.prompt_tokens;
  const outputTokens = raw?.completion_tokens;
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  return {
    ...(valid(inputTokens) ? { inputTokens } : {}),
    ...(valid(outputTokens) ? { outputTokens } : {}),
    status: valid(inputTokens) && valid(outputTokens) ? 'reported' : 'unknown'
  };
}

async function readBounded(response, bytesLimit) {
  if (!response.body) fail('PROVIDER_FAILURE', 'Provider response has no readable body');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > bytesLimit) fail('OUTPUT_TOO_LARGE', 'Provider response exceeded the byte limit');
      chunks.push(value);
    }
    const all = new Uint8Array(length);
    let pos = 0;
    for (const part of chunks) { all.set(part, pos); pos += part.length; }
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    fail('PROVIDER_FAILURE', 'Provider response could not be read');
  } finally { try { await reader.cancel(); } catch { /* no-op */ } reader.releaseLock(); }
}

/** OpenAI chat-completions wire format; works with Ollama's /v1 compatibility endpoint. */
export function createOpenAICompatibleProvider({
  endpoint, model, apiKey, allowedHosts, provider = 'openai-compatible',
  fetchImpl = globalThis.fetch, jsonMode = true, maxOutputTokens = 2048
}) {
  const url = validateEndpoint(endpoint, allowedHosts);
  if (typeof model !== 'string' || !model.trim() || model.length > LIMITS.modelLength ||
      typeof provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider) ||
      typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 || maxOutputTokens > 8192 ||
      (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey.trim())))
    fail('INVALID_PROVIDER_CONFIG', 'Invalid model, provider, key, fetch, or token cap');
  return Object.freeze({
    name: provider,
    model,
    async complete(request, { signal }) {
      const body = JSON.stringify({ model, messages: buildMessages(request),
        temperature: 0, max_tokens: maxOutputTokens,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) });
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body
        });
      } catch (err) {
        if (signal.aborted) throw err; // caller classifies deadline versus cancellation
        fail('PROVIDER_UNAVAILABLE', 'Inference provider is unreachable');
      }
      if (!response || typeof response.status !== 'number')
        fail('PROVIDER_FAILURE', 'Invalid provider HTTP response');
      if (!response.ok) {
        if (response.status === 429) fail('PROVIDER_RATE_LIMITED', 'Inference provider rate limited', { status: 429 });
        if ([401, 403].includes(response.status)) fail('PROVIDER_AUTH', 'Provider credentials were rejected', { status: response.status });
        if ([502, 503, 504].includes(response.status)) fail('PROVIDER_UNAVAILABLE', 'Inference provider unavailable', { status: response.status });
        fail('PROVIDER_FAILURE', 'Inference provider rejected the request', { status: response.status });
      }
      // Chat envelope can be larger than the completion; both are hard-capped before JSON.parse.
      const raw = await readBounded(response, LIMITS.outputBytes + 4096);
      let data;
      try { data = JSON.parse(raw); }
      catch { fail('PROVIDER_FAILURE', 'Provider returned an invalid response envelope'); }
      const choice = data?.choices?.[0];
      if (!choice || typeof choice.message?.content !== 'string' ||
          choice.finish_reason === 'length' || choice.finish_reason === 'content_filter' ||
          choice.message.content.length === 0)
        fail('PROVIDER_FAILURE', 'Provider returned an empty, truncated, or filtered completion');
      if (Buffer.byteLength(choice.message.content, 'utf8') > LIMITS.outputBytes)
        fail('OUTPUT_TOO_LARGE', 'Model completion exceeds the byte limit');
      return Object.freeze({
        content: choice.message.content, provider, model,
        usage: safeUsage(data.usage),
        metadata: Object.freeze({ finishReason: typeof choice.finish_reason === 'string'
          ? choice.finish_reason.slice(0, 40) : 'unknown',
          reportedModel: typeof data.model === 'string' ? data.model.slice(0, LIMITS.modelLength) : null })
      });
    }
  });
}

/** Exact-brief offline fixture replay. Not a model or a live inference claim. */
export function createFixtureProvider({ cases, model = 'fixture-v1' }) {
  if (!Array.isArray(cases) || !cases.length || typeof model !== 'string' || !model.trim())
    fail('INVALID_PROVIDER_CONFIG', 'Fixture provider requires nonempty cases');
  const map = new Map();
  for (const row of cases) {
    if (!row || typeof row.requestId !== 'string' || typeof row.brief !== 'string' ||
        map.has(row.requestId) || (!row.output && row.output !== ''))
      fail('INVALID_PROVIDER_CONFIG', 'Invalid or repeated fixture request ID');
    map.set(row.requestId, row);
  }
  return Object.freeze({ name: 'fixture', model,
    async complete(request, { signal }) {
      if (signal.aborted) fail('CANCELLED', 'Extraction was cancelled');
      const row = map.get(request.requestId);
      if (!row || row.brief !== request.brief)
        fail('FIXTURE_NOT_FOUND', 'No fixture matches request ID and exact brief');
      return { content: typeof row.output === 'string' ? row.output : JSON.stringify(row.output),
        provider: 'fixture', model, usage: { status: 'unknown' },
        metadata: { finishReason: 'fixture', reportedModel: null } };
    }
  });
}
