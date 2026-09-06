# Project Information

## Status

| Item | Value |
| --- | --- |
| Version | `0.1.0` |
| License | Apache-2.0 |
| Node requirement | 22.18+ for workspace tooling; 22.12+ for installed Node capability packages |
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

The package graph is enforced by `PACKAGE_RULES` in `scripts/package-policy.mts`,
checked by the CI graph and runtime-boundary gates. Preservation is the default:
a removal from a public entrypoint is a breaking change and needs a changeset
plus a consumer migration path.

## Public surface

The documented root plus the listed subpaths are public. Internal source paths
are **not** compatibility contracts — deep imports into `dist/` or `src/`
internals will break without a major version.

See [the package map](/en/01-introduction/getting-started) for every package's public
entrypoints.

## Where decisions are recorded

| Decision | Recorded in |
| --- | --- |
| Retaining exact `eventsource-parser@4.1.0` in `provider-http` | [Dependency policy](/en/14-project/dependency-policy) and `docs/dependency-policy.md` |
| The capability package split and API contract | `docs/core-capability-composition-design.md` |

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
