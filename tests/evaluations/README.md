# Scopehatch evaluation harness — sprint 01

This is an independently executable Node.js 22+ harness with **no external npm dependencies**. It modifies only `tests/evaluations/**` and `examples/evaluation/**`. No real client data or credentials are included.

## Run from the repository root

```bash
node --test tests/evaluations/*.test.mjs
node tests/evaluations/runner.mjs --strict --output /tmp/scopehatch-eval.json
EVAL_MODEL_URL=http://127.0.0.1:11434/v1/chat/completions EVAL_MODEL=llama3.2 \
  node tests/evaluations/runner.mjs --mode live \
  --adapter ./examples/evaluation/openai-compatible.mjs \
  --max-attempts 1 --timeout-ms 30000 --seed 7 \
  --output /tmp/scopehatch-live-eval.json
```

For a remote HTTPS OpenAI-compatible endpoint, set `EVAL_MODEL_URL`, `EVAL_MODEL`, and `EVAL_API_KEY` through environment variables. Never put secrets in source, fixtures, or shell history. Provider-specific JSON-mode/seed support can differ. `--cases ./other-cases.json` selects another fixture manifest; stdout is machine-readable JSON. `--output` is optional; when used it creates a permission-restricted local file. With `--strict`, gate failures exit 1 and configuration errors exit 2. Non-strict mode produces a report without asserting the score is good.

To evaluate a real deployed API later, implement a separate ESM `runWorkflowCase({caseId,scenario,expected})` and run with `--workflow-adapter ./your-api-adapter.mjs`. Its return shape is `{allowed:boolean, code:string|null, priceCorrect:boolean|null}`. It **must** perform actual authenticated requests under separate operator, reviewer and other-tenant principals, compare approval-bound exported revision and catalog-derived prices, and check audit activity; HTTP 2xx alone does not imply task success. Currently, without this adapter, the workflow tests call `src/domain.mjs` directly and verify only its in-process rules.

## Interpretation

`cases.json` has nine synthetic extraction briefs, nine pure-domain state-machine scenarios, and four simulated fault sequences. The fixture adapter constructs canned responses from hand-authored golden outputs. A perfect **fixture-mode** score is evidence of harness conformance, **not** evidence of model accuracy, deployment security, or provider reliability.

Metrics and their denominators:

- `requiredFieldAccuracy`: correct catalog ID and quantity fields / gold fields, with two additional denominator penalties per unexpected mapping.
- `evidenceSpanValidity`: generated spans that exactly match the original JavaScript UTF-16 brief substring / generated evidence spans. Missing spans additionally fail schema and attribution scoring.
- `evidenceAttributionAccuracy`: expected deliverables with citation covering the gold support quote / expected deliverables.
- `unknownAbstentionAccuracy`: correctly null quantities or correctly omitted unrecognized services / required abstentions.
- `unknownLabelAccuracy`: expected normalized unknown labels found / union of expected and output labels.
- `falseCommitmentRate`: attempted extractions containing forbidden authority/price fields or explicit approval/quote claims / attempted extractions.
- `schemaValidationPassRate`: strictly valid extraction responses / attempted extractions.
- `taskCompletionUnderApprovalRules`: workflows with expected allow/deny, rejection code, and correct catalog-derived price / workflows.
- `failureRecoveryBehavior`: correct scripted bounded-retry outcomes / scripted fault scenarios.

A zero-denominator metric is `null`, not a manufactured 100%. The checks distinguish schema correctness from evidence grounding. Citation checks are substring-based and cannot prove semantic relevance beyond gold evidence. Unknown-label matching is exact case-normalized, not synonym-sensitive. No real model call has been benchmarked until the live adapter command is actually executed.

Outputs include run timestamp, duration, Node/platform/architecture/logical CPU metadata, seed, fixture SHA-256, extraction provider/model, case-level results, and the explicit evidence-class labels `deterministic_fixture_conformance_only` or `live_extraction_with_local_domain_checks`. Reports deliberately exclude raw briefs, model completions, error messages, keys, JWTs, and tracing payloads. Unreported usage is `unknown`, not zero-cost.

## Coverage gaps and integration handoff

- The current scenario runner exercises pure `src/domain.mjs` invariants (self-approval, stale revision/catalog, mismatched tenant/rate card, missing quantities and forged price instruction). It does not exercise HTTP auth, OIDC validation, PostgreSQL RLS, idempotency, concurrent approvals, or durable audit.
- Retry fault cases are synthetic and test classification and attempt bounds only. Provider circuit breakers, cancellation of billable requests, concurrent reservations, cost reconciliation, actual outage behavior and backoff must be assessed against the governance and persistence integrations.
- Live model evaluations need provider-specific JSON generation settings and held-out human-annotated fixtures; this is a minimal synthetic suite, not a statistical benchmark.
- The integrator must hook this directory into root CI and coordinate real API/model integration. No root scripts, shared fixtures, domain tests, packages or other workers' files were changed.

See [live adapter example](../../examples/evaluation/openai-compatible.mjs).
