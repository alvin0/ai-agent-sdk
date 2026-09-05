# I7 capability and facade removal evidence

Recorded: 2026-09-04

The `agent`, `observability`, `node`, and `sdk` bridge package directories are
absent. Active source, tests, spikes, and human harnesses use the canonical core
subpaths or explicit capability packages. The source migration contract is in
the `deleted` state and the documentation migration contract is `complete`.

All 17 non-core package READMEs provide an explicit install command,
recommended entrypoint, composition location, runtime classification, and
lifecycle ownership. The core README documents `createAgentRuntime`,
`defineAgent`, and `SdkLogger`. Recommended MCP HTTP and stdio recipes construct
the runtime before the connection, pass a bound runtime logger, and use nested
cleanup so runtime quiescence cannot prevent connection teardown.

Verification commands and results:

- `pnpm check:core-capability-contract`: passed all 17 typed composition proofs,
  17 package-local install closures, 18 exact manifest blueprints, 56 migrated
  source files, and zero pending API parity symbols.
- `pnpm check:docs`: passed 57 Markdown files and all 19 workspace READMEs.
- `pnpm check:boundary-fixtures`: rejected the persistent invalid fixtures and
  the generated per-package matrix for all 18 target packages. Each package has
  an undeclared-dependency rejection; Universal/Browser packages reject Node
  built-ins, and Node capabilities reject escalation from a Universal consumer.
- `pnpm check:graph`: previously passed after the facade deletion; it is rerun
  as part of final release readiness.

The removed directories were moved to the desktop trash during implementation;
tracked source remains recoverable from Git and generated outputs can be rebuilt.
