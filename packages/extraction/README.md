# @scopehatch/extraction

A dependency-free Node.js 22+ ESM extraction port with `.d.mts` types. It turns a client brief and an **allowed service catalog** into untrusted draft scope suggestions. It does not price, approve, mutate scope or catalog state, read tenants from client headers, send email, or perform any external business action. The sole live side effect is a **configured model HTTP request**. The package does **not** reserve budgets, authenticate callers, or persist auditing; those remain API/governance/integration duties.

## Run independently

```sh
cd packages/extraction
npm test              # 12 node:test tests, no downloads required
node evaluate.mjs     # JSON synthetic fixture replay report (NOT live-model accuracy)
```

## Dependency-injected integration hook

```js
import { createExtractor, createOpenAICompatibleProvider } from '@scopehatch/extraction';

const provider = createOpenAICompatibleProvider({
  endpoint: 'http://127.0.0.1:11434/v1/chat/completions', // Ollama OpenAI-compatible mode
  allowedHosts: ['127.0.0.1'], // explicitly configured by trusted operator
  model: 'your-installed-local-model',
  provider: 'ollama'
});
const { extractBrief } = createExtractor({ provider, timeoutMs: 15_000 });

// API layer: verify auth/tenant, permissions and catalog ownership FIRST.
// Governance layer: check model/data policy and reserve billable usage FIRST.
const result = await extractBrief({
  brief: 'Please produce 3 exterior renders, resolution TBD.',
  serviceCatalog: [{ id: 'exterior-render', label: 'Exterior render' }],
  requestId: 'trace-123'
}, { tenantId: verifiedPrincipal.tenantId, signal: requestAbortSignal });
// Present result for operator confirmation; no automatic scope or quote write.
```

The public factory returns the frozen contract-shaped `extractBrief(input, context)` method. An additional low-level `extractBrief(input, context, provider, { timeoutMs })` export supports direct dependency injection. A deterministic `createFixtureProvider({ cases })` adapter replays only matching request ID **and exact brief**; it does not pretend to make model predictions.

### Live model check (explicit opt-in)

```sh
# Start Ollama and install a compatible model separately; example assumes one is already running.
SCOPEHATCH_EXTRACTION_ENDPOINT=http://127.0.0.1:11434/v1/chat/completions \
SCOPEHATCH_EXTRACTION_MODEL=your-installed-local-model \
node live-check.mjs

# Or an operator-approved HTTPS OpenAI-compatible endpoint with env-only BYOK key:
SCOPEHATCH_EXTRACTION_ENDPOINT=https://api.openai.com/v1/chat/completions \
SCOPEHATCH_EXTRACTION_MODEL=your-approved-model \
SCOPEHATCH_EXTRACTION_API_KEY=... node live-check.mjs
```

Only run against an approved provider; the synthetic script intentionally prints the full **synthetic** brief/result. No live provider was accessible in the authoring environment, so the test evidence is limited to fixture replay and mocked HTTP protocol calls. No real-model correctness, cost, latency, or token claim is made.

## Boundary and contracts

- `input`: `{ brief, serviceCatalog: [{id,label}], requestId }`. Prices are never passed to the provider, even if caller supplied extra catalog fields. `context`: `{ tenantId, signal? }`. `tenantId` is required and never sent to the model, but **this is not an authentication check**. Caller must resolve verified tenant membership and a tenant-owned catalog.
- `result`: `{ suggestedDeliverables: [{serviceId,quantity,evidence}], unknowns, provider, model, usage, provenance, modelMetadata }`, compatible with `contracts/sprint-01-interface.md`. `quantity` is a positive safe integer or explicit `null`; evidence is `{start,end,quote}` or `null`, with `start` inclusive / `end` exclusive **UTF-16** positions in the original brief. All non-null spans are checked byte-for-byte as JS substrings and cannot split surrogate pairs. A non-null quantity additionally requires its digit spelling in the cited span. A `null` evidence is **missing evidence**, not a citation and must remain a downstream blocker.
- Complete model object must contain *only* `suggestedDeliverables` and `unknowns`; each proposed item *only* `serviceId`, `quantity`, `evidence`; each evidence *only* `start`, `end`, `quote`. The validator rejects unknown catalog IDs and extra keys (including prices, approval states, permissions). Structured schema validity is separate from semantic accuracy: a model might still connect the wrong service to a real substring; human review remains required.
- Prompt `brief-to-proposal/1.0.0` and schema `extraction/1.0.0` are version-tagged. Client brief is serialized as data, not instructions. Prompts are a defense-in-depth measure only; deterministic validation and caller permissions are the enforcement boundary.
- Bounds: brief 20k UTF-16 units, 100 catalog services, 100 deliverables/unknowns, completion 32 KiB, HTTP response envelope 36 KiB, configured output tokens max 8192. HTTP redirects blocked. HTTPS with explicit host allowlist; HTTP permits loopback only. Timeout 1–120 seconds (default 15), cancellation propagated and enforced by the service even when a test adapter ignores abort.
- Errors use `ExtractionError` with `code`, safe `message`, `provider`, `requestId`, optional HTTP `status`. Codes include `INVALID_INPUT`, `INVALID_MODEL_OUTPUT`, `UNVERIFIABLE_EVIDENCE`, `UNVERIFIABLE_QUANTITY`, `PROVIDER_NOT_CONFIGURED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `PROVIDER_AUTH`, `PROVIDER_FAILURE`, `OUTPUT_TOO_LARGE`, `CANCELLED`, `TIMEOUT`, `FIXTURE_NOT_FOUND`. Never log `error.cause`, provider body, brief, or secret headers.
- `usage.status` is `reported` only when **both** prompt and completion token counts are valid; otherwise `unknown`, with available partial counters retained. Unknown is never coerced to zero. `model` is the trusted configured value; `modelMetadata.reportedModel` is the untrusted provider self-report. No currency/cost calculated here.

## Integration handoff and remaining risks

1. API dependency-injects the factory into `POST /v1/projects/:id/suggestions`. Load the **immutable original brief** and allowed catalog for that authenticated workspace, never from the model or user-supplied tenant ID. Persist provenance / audit on the API side, and return the draft only; a separate human-initiated scope revision requires authorization.
2. Governance selects the tenant-allowed model, handles jurisdiction and secrets, reserves worst-case provider spend *before* calling, then settles/reconciles with reported-versus-unknown usage. Do not retry billable requests without governing idempotency. The extractor itself makes one call and never declares the call free when usage is absent.
3. API maps `INVALID_*` / `UNVERIFIABLE_*` to 422, `PROVIDER_RATE_LIMITED` to 429, unavailable/failure/auth to safe 503 (misconfiguration requires operator attention), `TIMEOUT` to 504 or documented unavailable code, and `CANCELLED` to a server-appropriate aborted response. The frozen API contract has no dedicated extraction endpoint error mapping; the integrator must document final mapping.
4. Privacy/egress: only send client data to explicit tenant-approved destinations. The allowlist alone does not secure DNS resolution against rebound/evil egress; enforce network policy / pinned gateway DNS or egress proxy in production. No raw logs/tracing of prompts or provider error bodies. Live-model grounding and prompt injection performance have **not** been demonstrated; evaluate multiple models and real samples before claiming them.
5. Known conservative limit: quantities written only in words (`three`, `a dozen`) are left as `null` rather than inferred. Real providers may return valid-but-semantically-wrong spans. There is no tool calling, no automatic clarification questions, no attachment OCR, and no authoritative decisions.
