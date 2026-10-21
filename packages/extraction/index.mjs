import { ExtractionError, fail } from './errors.mjs';
import { validateInput, validateCompletion } from './validation.mjs';
import { PROMPT_VERSION, SCHEMA_VERSION } from './prompt.mjs';

export { ExtractionError } from './errors.mjs';
export { LIMITS, validateCompletion } from './validation.mjs';
export { PROMPT_VERSION, SCHEMA_VERSION } from './prompt.mjs';
export { createOpenAICompatibleProvider, createFixtureProvider } from './provider.mjs';

/** The explicit third argument exists for callers that do not use the factory. */
export async function extractBrief(input, context, provider, { timeoutMs = 15000 } = {}) {
  const validated = validateInput(input, context);
  if (!provider || typeof provider.complete !== 'function' ||
      typeof provider.name !== 'string' || typeof provider.model !== 'string')
    fail('PROVIDER_NOT_CONFIGURED', 'An explicit extraction provider is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail('INVALID_INPUT', 'timeoutMs must be between 1 and 120000');
  if (context.signal?.aborted) fail('CANCELLED', 'Extraction was cancelled', { requestId: validated.requestId });
  const timeoutController = new AbortController();
  let deadlineFired = false;
  // Referenced timer: deadline must fire even if an adapter never creates I/O.
  const timer = setTimeout(() => { deadlineFired = true; timeoutController.abort(); }, timeoutMs);
  const signal = context.signal ? AbortSignal.any([context.signal, timeoutController.signal]) : timeoutController.signal;
  const started = performance.now();
  let onAbort;
  try {
    // Race even badly behaved adapter doubles that fail to honor abort signals.
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('aborted'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    const raw = await Promise.race([provider.complete(validated, { signal }), aborted]);
    if (signal.aborted) throw new Error('aborted');
    if (!raw || typeof raw.content !== 'string')
      fail('PROVIDER_FAILURE', 'Provider returned no completion');
    const parsed = validateCompletion(raw.content, validated);
    const usage = raw.usage;
    const safeInt = n => Number.isSafeInteger(n) && n >= 0;
    const safeUsage = {
      ...(safeInt(usage?.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
      ...(safeInt(usage?.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
      status: safeInt(usage?.inputTokens) && safeInt(usage?.outputTokens) ? 'reported' : 'unknown'
    };
    return Object.freeze({ ...parsed, provider: provider.name, model: provider.model,
      usage: Object.freeze(safeUsage),
      provenance: Object.freeze({ source: 'submitted-brief', offsetEncoding: 'utf16',
        promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, requestId: validated.requestId,
        evidenceVerified: true }),
      modelMetadata: Object.freeze({ latencyMs: Math.round(performance.now() - started),
        finishReason: typeof raw.metadata?.finishReason === 'string' ? raw.metadata.finishReason : 'unknown',
        reportedModel: typeof raw.metadata?.reportedModel === 'string' ? raw.metadata.reportedModel : null }) });
  } catch (err) {
    const metadata = { provider: provider.name, requestId: validated.requestId };
    if (context.signal?.aborted) fail('CANCELLED', 'Extraction was cancelled', metadata);
    if (deadlineFired) fail('TIMEOUT', 'Inference deadline exceeded', metadata);
    if (err instanceof ExtractionError)
      throw new ExtractionError(err.code, err.message, { ...metadata, status: err.status });
    fail('PROVIDER_FAILURE', 'Inference provider failed without a safe error', metadata);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Returns a contract-shaped extractBrief(input, context) method for API dependency injection. */
export function createExtractor({ provider, timeoutMs = 15000 }) {
  if (!provider) fail('PROVIDER_NOT_CONFIGURED', 'An explicit extraction provider is required');
  return Object.freeze({ extractBrief: (input, context) => extractBrief(input, context, provider, { timeoutMs }) });
}
