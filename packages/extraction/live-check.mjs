// Explicit opt-in live verification. Never runs as part of the offline tests.
import { createExtractor, createOpenAICompatibleProvider } from './index.mjs';

const endpoint = process.env.SCOPEHATCH_EXTRACTION_ENDPOINT;
const model = process.env.SCOPEHATCH_EXTRACTION_MODEL;
if (!endpoint || !model) {
  console.error('Live verification not run. Set SCOPEHATCH_EXTRACTION_ENDPOINT and SCOPEHATCH_EXTRACTION_MODEL.');
  process.exitCode = 2;
} else {
  const host = new URL(endpoint).hostname;
  const provider = createOpenAICompatibleProvider({
    endpoint, model, allowedHosts: [host],
    apiKey: process.env.SCOPEHATCH_EXTRACTION_API_KEY,
    provider: 'live-check', maxOutputTokens: 2048
  });
  const extractor = createExtractor({ provider, timeoutMs: 20000 });
  const brief = 'Please produce 3 exterior images from our SketchUp model. The deadline is not decided.';
  try {
    const result = await extractor.extractBrief({ brief, requestId: 'synthetic-live-check',
      serviceCatalog: [{ id: 'exterior-render', label: 'Exterior render' },
        { id: 'interior-render', label: 'Interior render' }] },
    { tenantId: 'synthetic-live-check' });
    console.log(JSON.stringify({ verification: 'live-model', endpointHost: host,
      inputBrief: brief, result }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ verification: 'live-model-failed', code: err.code ?? 'ERROR',
      provider: err.provider ?? 'live-check' }));
    process.exitCode = 1;
  }
}
