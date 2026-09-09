# Project Information

## Status

| Item | Value |
| --- | --- |
| Version | `0.1.0` |
| License | MIT |
| Node requirement | 22.18+ for workspace tooling; 22.12+ for installed Node capability packages |
| Registry publication | **Published** — 21 packages under `@alvin0` |

## Registry publication

All 21 publishable packages are on npm under the `@alvin0` scope, named
`@alvin0/ai-agent-sdk-<capability>`. The scope `@ai-agent-sdk` belongs to a
different account, which is why the published names carry the project as a name
prefix rather than as the scope.

Releases run from `.github/workflows/release.yml` on a `v*` tag: the CI gates
run, `pnpm pack` resolves `workspace:^` and `catalog:` specifiers into real
ranges, and each tarball is published with `npm publish --provenance`, so every
version carries a SLSA provenance attestation.

`@alvin0/ai-agent-sdk-testkit` stays private — it is only ever a devDependency
of the provider packages.

To install from a local tarball instead:

```bash
pnpm add ./artifacts/alvin0-ai-agent-sdk-core-0.1.0.tgz
```

## Versioning

Every package is currently `private` and versions are set directly in each
manifest. There is no release-notes tool in the repository.

The package graph is enforced by `PACKAGE_RULES` in `scripts/package-policy.mts`,
checked by the CI graph and runtime-boundary gates. Preservation is the default:
a removal from a public entrypoint is a breaking change and needs a consumer
migration path.

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
