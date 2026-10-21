# Workpack interface (draft)

Workpacks encapsulate a versioned business workflow. A manifest declares identifier, version, input/output schemas, required capabilities, side-effect permissions, budget defaults, reviewer gates, evaluation fixtures and failure behavior. The platform authenticates callers and resolves policy before loading a workpack. Workpacks cannot elevate permission by changing their manifest.

For `brief-to-proposal`, input is a client brief and catalog reference; extraction suggests a scope with evidence and unknowns; deterministic pricing runs separately; review binds exact revisions; export produces a draft. No external send permission in v0.

Manifest/schema examples live in `workpacks/brief-to-proposal/`. These are planned interfaces until an executable registry exists.