# Bootstrapping and repository governance

Default branch: `main`. Prefer small feature branches and PRs with reproductions, tests, evidence and explicit scope. Keep contract changes in docs and tests. Do not force-push shared branches.

Suggested layout:
```
apps/api/           # Fastify HTTP + authorization (planned)
apps/web/           # Vue operator workbench (planned)
packages/core/      # scope/pricing/approval invariants
packages/inference/ # providers, metering, routing (planned)
workpacks/          # declarative workflows
docs/               # live specs; archive/ is design history only
test/               # deterministic tests
examples/           # runnable demos
```
Use npm/node:test for zero-dependency kernel first, then transition safely to pnpm workspaces once the API/web exist. Do not overclaim the stub is operational SaaS.

Local goals for day 1: `npm test`, `npm run demo`. Tests must cover cross-tenant rejection, unknown quantity, unpriced catalog entries, stale scope approval, two-person review and safe money arithmetic.

Branch protections and release gates should be enabled after CI is confirmed green. Never commit personal customer data, credentials or true project price sheets.