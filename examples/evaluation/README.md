# Evaluation adapter examples

`openai-compatible.mjs` exports `extractBrief(input, context)` for OpenAI-compatible chat-completions endpoints, including a local Ollama-compatible endpoint. Set `EVAL_MODEL_URL`, `EVAL_MODEL`, and optionally `EVAL_API_KEY` via the environment. HTTPS is required for remote hosts; HTTP is permitted only for loopback. The example sends only synthetic fixtures, asks for JS UTF-16 evidence offsets, and never stores model outputs in the report.

Not every provider supports both `response_format: {type:'json_object'}` and `seed`; adjust this optional adapter for your provider. The harness validates all provider output separately: an HTTP success or valid JSON is not enough.

When the Fastify API, JWT identity, and PostgreSQL packages are integrated, implement a local `runWorkflowCase({caseId, scenario, expected})` module that returns `{allowed, code, priceCorrect}`. It should perform genuine authenticated project, scope, estimate, review, approve, export and audit requests, use three verified principals (operator, independent reviewer, other tenant), check exact revision/catalog versions, and verify authoritative catalog pricing. Use `--workflow-adapter ./path/to/adapter.mjs` to inject it. Do not place JWTs, user secrets, response bodies, or full briefs in returned values.
