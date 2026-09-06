# Project Information

## Status

| Item | Value |
| --- | --- |
| Version | `0.1.0` |
| License | Apache-2.0 |
| Node requirement | 22.12 or newer for workspace tooling and Node capability packages |
| Registry publication | **Intentionally deferred** |

## Registry publication

Publication to npm is intentionally deferred while ownership of the scope is
being arranged. The install commands throughout this documentation describe the
**intended** install profiles for a future registry release.

Current validation installs the generated tarballs or uses the workspace
directly:

```bash
pnpm add ./artifacts/ai-agent-sdk-core-0.1.0.tgz
```

## Versioning

Releases use [Changesets](https://github.com/changesets/changesets).

```bash
pnpm changeset          # describe a change
pnpm version-packages   # apply version bumps
```

The public API is protected by frozen ledgers under `design-contracts/`.
Preservation is the default: **journey declarations cannot authorize deletion of
an unmentioned symbol**, and every removal needs an approved decision plus a
consumer migration path.

## Public surface

The documented root plus the listed subpaths are public. Internal source paths
are **not** compatibility contracts — deep imports into `dist/` or `src/`
internals will break without a major version.

See [the package map](/en/01-introduction/getting-started) for every package's public
entrypoints.

## Architecture decision records

| ADR | Subject |
| --- | --- |
| `docs/adr/0001-eventsource-parser-ownership.md` | Why exact `eventsource-parser@4.1.0` is retained in `provider-http` |
| `docs/adr/0002-core-capability-package-and-api-contract.md` | The capability package split and API contract |

## In this section

- [Contributing](/en/14-project/contributing)
- [Testing and acceptance](/en/14-project/testing)
- [Dependency policy](/en/14-project/dependency-policy)
- [testkit](/en/14-project/testkit)
- [License](/en/14-project/license)

## Design documents

The `docs/` directory holds the design record behind this documentation:

| Document | Subject |
| --- | --- |
| `agent-definitions.md` | Modes, native tools, variants, session ownership |
| `memory-and-compaction.md` | Persistence, overflow recovery, lifecycle events |
| `tool-loop-design.md` | Loop architecture, bounds, checkpoint contract |
| `mcp.md`, `a2a.md` | Integration boundaries |
| `observability-and-usage-architecture.md` | The observation data model |
| `monorepo-package-architecture.md` | Package split rationale |
| `core-capability-composition-design.md` | The composition design |
| `dependency-policy.md` | Supply-chain exceptions and review expiry |
| `public-api-baseline.md` | The frozen public API inventory |
