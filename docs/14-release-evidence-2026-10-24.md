# Scopehatch Sprint 02 — release evidence checkpoint (24 October 2026)

**Decision: developer/fixture demonstration only (Level A). Not yet authorized as a real-customer or public deployment.** The [release gates](13-sprint-02-release-gates.md) define separate Level B/C/D acceptance.

## Implemented and merged

- [#32](https://github.com/Ni-zav/scopehatch/pull/32): the Sprint 02 API, database, SDK, Vue workbench, onboarding, recovery and evaluation modules were integrated.
- [#33](https://github.com/Ni-zav/scopehatch/pull/33): PostgreSQL recovery rehearsal startup race fixed.
- [#36](https://github.com/Ni-zav/scopehatch/pull/36), merged as `d339ffab`: production and build images pinned to patched Node.js 22.23.4. [Core CI](https://github.com/Ni-zav/scopehatch/actions/runs/40068954319) and [integration CI](https://github.com/Ni-zav/scopehatch/actions/runs/40068954495) passed on exact PR head `5c6288d5`.
- [#34](https://github.com/Ni-zav/scopehatch/pull/34), merged as `3d6c0525`: five entirely fictional studio scenarios, participant instructions and non-fabricated measurement sheets. [Core CI](https://github.com/Ni-zav/scopehatch/actions/runs/39722359305) and [integration CI](https://github.com/Ni-zav/scopehatch/actions/runs/39722359103) passed on exact PR head `8c4f7cba`.
- [#35](https://github.com/Ni-zav/scopehatch/pull/35), merged as `d87b0fce`: SDK rejects remote cleartext bearer-token transport and all redirects; production requires a stable private pagination cursor signing key; core CI validates the synthetic pilot deck. [Core CI](https://github.com/Ni-zav/scopehatch/actions/runs/40084112154) and [integration CI](https://github.com/Ni-zav/scopehatch/actions/runs/40084112152) passed on exact PR head `230d53d6`.

**Evidence interpretation:** these runs exercised synthetic/disposable CI environments, not an external operator's identity or live customer data. Required `test`, `contracts`, `postgres-security` and `compose-smoke` all passed on the three PR heads. Check the **latest `main` SHA** and its own Actions runs before any release decision. A successful PR run is not a substitute for a successful final-commit run.

## Safe demo now

Use patched Node.js **22.23.4** (see [`.nvmrc`](../.nvmrc)) and run from the repository root:

```sh
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm run test:unit
npm run test:eval
node examples/pilot/validate.mjs
npm run demo
npm run dev --workspace @scopehatch/web
```

Open `http://localhost:4173`. This **fixture-only** Vue workbench uses synthetic actors and nonpersistent prices; it is not real authentication. Run the [fictional pilot cases](../examples/pilot/README.md) following the [pilot protocol](pilots/README.md). A demo success is not evidence of real-customer usability.

## What still blocks a real self-hosted pilot (Level B)

1. Operator-owned private deployment, trusted external OIDC and verified actual tenant membership for separate author and reviewer; no fixture users or public self-registration.
2. End-to-end catalog → project → source evidence → estimate → independent approval → unsigned draft export through that actual configured instance; negative cross-tenant, stale terms and invalid identity checks.
3. TLS/secret storage, PostgreSQL restricted runtime role, tested backup and **isolated restore** with recorded results and a controlled rollback procedure.
4. Explicit data privacy/consent, storage/retention decision, support and incident handling before any proprietary briefs are used.
5. Independent security and release review of the real environment, including DB custom-GUC/SQL-injection residual risks.

Optional live inference is **not needed** for a Level B manual-first pilot. Enabling it requires separate Level C real-model, provider allowlist, held-budget, injection and unknown-usage evidence. Never claim real provider accuracy, cost or commercial demand based on fixture runs. No public or customer rollout is authorized by this checkpoint.

## CI merge hygiene

A prior squash merge retained a workflow-skip directive from the body of one historical feature commit, so the merged `main` commit did not itself start new workflows even though the PR had passed all checks. When squash-merging, explicitly supply a clean **title and body** and verify the new `main` Actions runs complete. Never bypass the configured required checks or rewrite protected history.
