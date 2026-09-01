# Monorepo Implementation Design

Status: implemented and R0-verified; release scope preflight pending

Baseline evidence: [implementation-spike-evidence.md](./implementation-spike-evidence.md)  
Architecture rationale: [monorepo-package-architecture.md](./monorepo-package-architecture.md)  
Companion observability design: [observability-implementation-design.md](./observability-implementation-design.md)

## 1. Scope and fixed decisions

This design converted the former single npm package into a pnpm workspace without changing the agent loop into separate Edge and Node implementations. The implementation follows one runtime-elevation rule:

```text
Universal application + Universal capability -> Universal application
Universal application + Node capability      -> Node application
```

The following decisions are closed for the initial migration:

1. The workspace package scope is `@ai-agent-sdk/*`. These names can be used locally regardless of registry ownership. Every new package remains `private: true` until the release preflight proves the authenticated publisher owns the scope.
2. The compatibility package keeps the unscoped name `ai-agent-sdk`.
3. Universal source uses Web Standards only. Node capability packages implement the same contracts through explicit imports; no environment sniffing changes a Universal package into Node at runtime.
4. The package manager is `pnpm@11.25.0`, pinned in `packageManager`. Turbo `2.10.12` owns the task graph. Changesets `3.0.1` owns versioning and publishing.
5. All public packages start in one Changesets fixed group at `0.1.0`. Internal dependencies use `workspace:^`.
6. Packages are ESM-only, `sideEffects: false`, target `ES2023`, emit declarations and source maps, and expose only declared `exports`.
7. `eventsource-parser@4.1.0` remains exact-pinned only as a direct dependency of `@ai-agent-sdk/provider-http`. ADR 0001 retains it after the owned candidate failed the mandatory throughput gate; replacement requires a new fully qualified decision.
8. MCP HTTP is Universal. MCP stdio and Node HTTP adapters are Node. The strict Worker round-trip in the evidence file proved this split.
9. A2A is Node-elevated in the initial release because `@a2a-js/sdk@1.1.0` requires `Buffer` for a public raw-binary path. It may be promoted only after the strict Worker fixture passes text, data, URL, and binary paths with Node globals removed.
10. The Universal Codex provider requires an injected `CodexAuthStore`. The project-local filesystem store and env/path resolution move to Node packages. The Universal package never imports `node:*` and never reads `process.env`.
11. Providers are explicit plugins. There is no package scanning, dynamic auto-discovery, or execution of manifest code during install.
12. The existing root import stays Universal. Legacy Node subpaths remain as compatibility re-exports and are labelled Node; they do not enter the root entry closure.

## 2. Repository layout

The final top-level layout is:

```text
.
├── .changeset/
├── docs/
├── packages/
│   ├── sdk/
│   ├── core/
│   ├── agent/
│   ├── provider-http/
│   ├── protocol-anthropic-messages/
│   ├── protocol-responses/
│   ├── provider-anthropic/
│   ├── provider-openai/
│   ├── provider-codex/
│   ├── observability/
│   ├── observability-fetch/
│   ├── observability-browser/
│   ├── observability-node/
│   ├── observability-otel/
│   ├── auth-node/
│   ├── skill-filesystem/
│   ├── mcp/
│   ├── mcp-node/
│   ├── a2a/
│   └── node/
├── scripts/
├── spikes/
├── tests/
│   ├── contract/
│   ├── fixtures/
│   ├── integration/
│   └── unit/
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.universal.json
├── tsconfig.node.json
└── turbo.json
```

The repository root is a private orchestration package. No runtime source remains under root `src/` after the compatibility package is proven from its packed tarball.

## 3. Public package matrix

“External runtime dependencies” excludes workspace dependencies.

| Package | Runtime | Purpose | External runtime dependencies |
|---|---|---|---|
| `@ai-agent-sdk/core` | Universal | Message/stream contracts, errors, model registry, plugin/observation ports, usage primitives | none |
| `@ai-agent-sdk/agent` | Universal | Agent loop, sessions, history, memory, tools, local teams, canonical run ledger | none |
| `@ai-agent-sdk/provider-http` | Universal | Fetch pipeline, SSE parsing, HTTP errors, configurable provider | `eventsource-parser@4.1.0` |
| `@ai-agent-sdk/protocol-anthropic-messages` | Universal | Anthropic wire schema, serializer, translator, dialect | none |
| `@ai-agent-sdk/protocol-responses` | Universal | OpenAI Responses/Codex wire schema, serializer, translator, dialect | none |
| `@ai-agent-sdk/provider-anthropic` | Universal | Anthropic adapter and provider plugin | none |
| `@ai-agent-sdk/provider-openai` | Universal | OpenAI adapter and provider plugin | none |
| `@ai-agent-sdk/provider-codex` | Universal | Codex adapter, OAuth, JWT helpers, memory/custom auth stores | none |
| `@ai-agent-sdk/observability` | Universal | Bus, processors, logger, in-memory exporter, health, test exporter | none |
| `@ai-agent-sdk/observability-fetch` | Universal | Remote acknowledged batch exporter and Edge lifecycle adapter | none |
| `@ai-agent-sdk/observability-browser` | Browser | IndexedDB durable queue and page lifecycle adapter | none |
| `@ai-agent-sdk/observability-node` | Node | JSONL journal, durable exporter, exact-wire diagnostic adapter | none |
| `@ai-agent-sdk/observability-otel` | Universal | Span identity plus event/metric/log mapping through caller-supplied OpenTelemetry API objects; no network exporter | peer `@opentelemetry/api@^1.9.1`; optional peer `@opentelemetry/api-logs@^0.221.0` |
| `@ai-agent-sdk/auth-node` | Node | Environment credential sources, project-local Codex file store, and Codex Node plugin/adapter wrapper | none |
| `@ai-agent-sdk/skill-filesystem` | Node | Local filesystem skill source | none |
| `@ai-agent-sdk/mcp` | Universal | MCP HTTP client/server bridge | `@modelcontextprotocol/client@2.0.0`, `@modelcontextprotocol/server@2.0.0` |
| `@ai-agent-sdk/mcp-node` | Node | MCP stdio and Node HTTP adapters | MCP client/server/node `2.0.0` |
| `@ai-agent-sdk/a2a` | Node | Official A2A client/server bridge | `@a2a-js/sdk@1.1.0` |
| `@ai-agent-sdk/node` | Node | Full batteries-included Node facade | no non-workspace direct imports |
| `ai-agent-sdk` | Mixed compatibility facade; `.` is Universal | Existing import compatibility and migration warnings in docs | regular deps are Universal core/agent/HTTP/protocols; legacy leaf targets are optional peers |

“Browser” is a capability-specific subset of Universal. `@ai-agent-sdk/observability-browser` may use IndexedDB and browser lifecycle events but must not use Node APIs. Edge code does not depend on it.

The initial public surface is exactly 20 packages: 19 scoped capability packages plus the unscoped compatibility facade. Across them there are seven unique non-workspace runtime/peer package names: `eventsource-parser`, three MCP packages, `@a2a-js/sdk`, and two OpenTelemetry API packages. Only the selected leaf package owns each dependency; the Universal root-only install reaches `eventsource-parser` but none of A2A, MCP, OpenTelemetry, filesystem, auth-file/env, or Node journaling.

## 4. Exact workspace dependency graph

The permitted runtime edges are:

```text
core
├── agent
├── provider-http ── eventsource-parser
├── protocol-anthropic-messages
├── protocol-responses
├── observability
│   ├── observability-fetch
│   ├── observability-browser
│   ├── observability-node [Node]
│   └── observability-otel
└── (interfaces consumed by every plugin)

provider-anthropic ── core + provider-http + protocol-anthropic-messages
provider-openai    ── core + provider-http + protocol-responses
provider-codex     ── core + provider-http + protocol-responses
mcp                ── core + agent + MCP client/server
mcp-node [Node]    ── mcp + MCP client/server/node
skill-filesystem   ── agent [Node]
a2a [Node]         ── core + agent + @a2a-js/sdk
auth-node [Node]   ── core + provider-codex
node [Node]        ── core + agent + all providers + observability/fetch/node/otel
                       + auth-node + skill-filesystem + mcp + mcp-node + a2a
sdk                ── core + agent + provider-http + both protocols
sdk legacy shims   ── optional peer edges to provider/integration/Node leaf packages
```

Rules enforced by dependency-cruiser and the packed-import scanner:

- `core` depends on no workspace package.
- `agent` depends only on `core`.
- protocol packages depend only on `core`.
- provider packages never depend on `agent` or a concrete observability package.
- `observability` depends inward on `core`; `core` never imports it.
- `observability-otel` depends on `observability`, peers on API-only OpenTelemetry packages, installs no global provider, and performs no network I/O.
- Universal packages never depend on Node packages, including as optional dependencies.
- Node packages may depend on Universal packages.
- no runtime or type-only workspace cycle is accepted; `disallowWorkspaceCycles: true` is set.
- tests may depend outward through test-only fixtures, but production source may not import test helpers.

## 5. Source ownership and moves

The implementation uses `git mv` and keeps each move compiling before the next package starts.

### 5.1 Core

Move all of `src/core/**` to `packages/core/src/**`, except `src/core/stream/sse.ts`, which moves to `packages/provider-http/src/sse.ts`.

Before moving, relocate `waitForSettlement` from `core/runtime/settlement.ts` to `core/async/settlement.ts`. Both registry and stream code import the inward async primitive. This removes the current `core/runtime` ↔ `core/stream` directory cycle.

Add these core modules:

```text
packages/core/src/observation/{context,event,port,usage}.ts
packages/core/src/plugin/provider-plugin.ts
```

Core retains API-key validation and static attribution helpers. It does not retain env lookup.

### 5.2 Agent

Move `src/agent/**` to `packages/agent/src/**`, except `src/agent/skill/filesystem.ts`.

Rename the local multi-agent folder from `agent/a2a` to `agent/team`; it is local orchestration, not the A2A wire protocol. Preserve deprecated type/export aliases for the current names through `@ai-agent-sdk/agent` until `1.0.0`.

Break the current `define` ↔ local-team cycle by introducing `agent/team/contracts.ts`. `AgentSession` implements a structural `TeamSessionPort`; `team.ts` depends only on that port. Composition helpers may depend on definitions, but definition/session modules never import a concrete team implementation.

Add the canonical run ledger under `packages/agent/src/accounting/**`. It owns agent-run aggregation; core owns only per-call/attempt accounting types.

### 5.3 HTTP and protocols

Move:

- `src/providers/base/**`, `src/providers/http-provider.ts`, and core SSE parsing to `provider-http`;
- `src/providers/protocols/anthropic-messages.ts` plus `src/providers/anthropic/{serialize,translate,wire}.ts` to `protocol-anthropic-messages`;
- `src/providers/protocols/openai-responses.ts` plus `src/providers/responses/**` to `protocol-responses`;
- only `src/providers/anthropic/{adapter,index}.ts` to `provider-anthropic`;
- only `src/providers/openai/{adapter,index}.ts` to `provider-openai`.

The two protocol packages own their wire types. Provider adapters import public protocol exports, never internal files. This removes the current provider/protocol cycles.

Move `apiKeyFromEnv` out of `http-provider.ts`. `provider-http` accepts literal or injected credential resolvers only. `@ai-agent-sdk/auth-node` owns `envCredential(name)`; the Node facade re-exports it.

### 5.4 Codex

Split `auth-file.ts` into:

- Universal `auth-contract.ts`: `CodexTokens`, `CodexAuthFile`, `CodexAuthStore`, memory store, claim parsing, refresh decisions;
- Node `@ai-agent-sdk/auth-node/codex`: path/env resolution and atomic file store.

`codexAdapter` in the Universal provider requires `authStore`; it has no hidden file default. `@ai-agent-sdk/auth-node` exports `codexNodePlugin(options)` and `codexNodeAdapter(options)`, which default to the project-local file store and preserve the current behavior. `@ai-agent-sdk/node` only re-exports them.

The Node default remains exactly `.providers/.codex/auth.json` relative to an explicit/default process working directory, with `AI_AGENT_SDK_CODEX_AUTH` as the Node-only override. The store creates parent directories privately, writes a unique same-directory temporary file with mode `0600`, syncs, atomically renames, and syncs the directory where supported. It never reads or writes `~/.codex/auth.json` implicitly, follows no credential-file symlink, and redacts location/account/token data from default telemetry.

The device-login CLI moves to `packages/auth-node/bin/ai-agent-sdk-codex-login.mjs`. It uses the Node auth store but calls Universal OAuth functions.

### 5.5 Observability and Node capabilities

The observability file split is defined in the companion design. Mapping to caller-supplied OpenTelemetry API objects lives in `observability-otel`; concrete OTLP SDKs/exporters remain host dependencies and do not enter an SDK package. The current exact request logger moves to `observability-node/src/diagnostic-wire-log.ts`, is opt-in, defaults to content policy `none`, and is exposed through the legacy `ai-agent-sdk/request-logger` shim.

Move filesystem skill, MCP, MCP Node, and A2A files into their corresponding packages. Do not copy source into the Node facade; it only re-exports package APIs.

## 6. Provider plugin contract

Core adds the following semantic contract; exact property names are normative:

```ts
export interface ModelProviderRegistrar {
  registerAdapter(routes: readonly string[], adapter: ModelAdapter): AdapterRegistrationHandle
  use(middleware: StreamMiddleware): () => void
}

export interface ModelProviderPlugin {
  readonly id: string
  readonly displayName: string
  setup(registrar: ModelProviderRegistrar): void | (() => void)
}

export interface PluginRegistrationHandle {
  (): void
  readonly pluginId: string
}
```

`ModelRegistry.install(plugin)` is synchronous and transactional. The registrar passed to `setup` is a staging registrar: calls to `registerAdapter` and `use` validate and record proposed mutations but do not change live routes, middleware, or notify topology listeners until commit.

1. reject an empty or duplicate plugin ID;
2. create a staging registrar and reject duplicate routes within the staged set or against the live registry;
3. run `setup` and record its optional cleanup callback;
4. if setup throws, discard the staged set without mutating live topology or notifying listeners;
5. atomically commit all staged routes and middleware, then emit one topology-change notification;
6. if commit validation fails, discard the staged set and run the setup cleanup callback once;
7. return one idempotent disposer that atomically removes the committed set, emits one notification, and then releases middleware/setup resources in reverse order.

Individual handles returned by the staging registrar are valid only inside setup and can cancel a staged item before commit. They cannot expose a partially installed plugin. JavaScript remains single-threaded across the synchronous commit; no awaited hook is allowed in `setup`.

Topology-listener failures are contained and reported through the registry observation context after the committed topology is visible; they do not roll back a valid install. Disposal marks the handle disposed and removes live routes before cleanup runs. Cleanup continues through every callback in reverse order; failures are collected into `PLUGIN_CLEANUP_FAILED` after topology removal, so retrying the disposer is a no-op. Setup/commit failure is `PLUGIN_INSTALL_FAILED`, retains the original cause/cleanup failures safely, and never exposes a partial route set.

Provider packages export both the low-level adapter and the preferred plugin factory:

```ts
registry.install(openAiPlugin({ apiKey }))
registry.install(anthropicPlugin({ apiKey }))
registry.install(codexPlugin({ authStore }))
```

There is no ambient global registry and no auto-install side effect on import. Plugin construction must not dispatch network requests. Catalog discovery remains lazy.

Skills retain their existing `SkillSource`/`SkillProvider` contracts because they are agent capabilities, not model-provider routes. A Node filesystem skill is linked by explicit injection into a Universal agent session; importing it is the act that elevates the application.

## 7. Package manifests and exports

Every publishable package uses this base shape:

```json
{
  "version": "0.1.0",
  "type": "module",
  "sideEffects": false,
  "files": ["dist", "README.md", "LICENSE"],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
}
```

Universal packages omit a public Node engine claim. The private workspace root and Node packages require Node `>=22.12`. `provider-http` documents that development/installation under Node follows the exact dependency's `>=22.12` engine even though its runtime code is Web-standard.

Subpath exports are allowed only where the subpath has a materially different capability boundary:

- `@ai-agent-sdk/observability/processors`, `/testing`;
- `@ai-agent-sdk/observability-node/journal`, `/diagnostic`;
- `@ai-agent-sdk/auth-node/codex`, `/env` and matching re-export subpaths from `@ai-agent-sdk/node`;
- no `./internal/*` exports.

Internal workspace dependencies are declared directly in the importing package with `workspace:^`. A package may not rely on root hoisting. External runtime dependencies use `catalog:` and exact catalog entries during pre-1.0.

## 8. Compatibility facade

`packages/sdk` owns `ai-agent-sdk`. Its export map preserves all 11 current subpaths:

| Legacy path | Target | Runtime |
|---|---|---|
| `ai-agent-sdk` | core + agent + provider-http configuration API + protocols | Universal |
| `/anthropic` | provider-anthropic | Universal |
| `/openai` | provider-openai | Universal |
| `/codex` | auth-node wrapper preserving file-store default and Universal Codex exports | Node |
| `/a2a-client`, `/a2a-server` | a2a | Node |
| `/mcp-client`, `/mcp-server` | mcp | Universal |
| `/mcp-node` | mcp-node | Node |
| `/skill-filesystem` | skill-filesystem | Node |
| `/request-logger` | observability-node diagnostic shim | Node |

Add `ai-agent-sdk/node` as the full Node facade. No runtime warning is printed on import; migration notices belong in docs and release notes, not stdout/stderr.

There is one intentional root-symbol break required by the runtime contract: `apiKeyFromEnv` is removed from `ai-agent-sdk` because a root-exported environment reader is not Universal. `@ai-agent-sdk/auth-node` exports a deprecated-compatible `apiKeyFromEnv` alias plus the preferred `envCredential`; `@ai-agent-sdk/node` re-exports both. The 0.1 migration guide and type snapshot call this out explicitly. No conditional/dynamic Node loader is added to hide the boundary.

The facade has regular dependencies only on `core`, `agent`, `provider-http`, and the two protocol packages needed by the current root API. Every legacy leaf target is an optional peer dependency and its shim statically re-exports that target. Therefore `npm install ai-agent-sdk` does not install A2A, filesystem, journal, stdio, or other Node-only closures. A legacy subpath consumer adds the corresponding new package explicitly; the migration table beside each subpath gives the exact install command. This is an intentional pre-1.0 installation change that protects the root runtime boundary while preserving source import names.

Compatibility is verified from two packed fixtures: root-only installation proves the Universal dependency closure, and a compatibility installation explicitly adds all optional peers before exercising every current import name and representative type-only import, with the single documented `apiKeyFromEnv` root-symbol exception. The compatibility facade stays through the 1.0 line. Removal or renaming requires a documented major release and replacement path.

## 9. TypeScript and build configuration

`tsconfig.base.json` contains strict shared settings, `module: ESNext`, `moduleResolution: Bundler`, `target: ES2023`, declaration/source maps, `verbatimModuleSyntax`, `isolatedModules`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.

`tsconfig.universal.json` adds:

```json
{
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": []
  }
}
```

`tsconfig.node.json` adds `types: ["node"]`. Browser packages extend Universal and add the IndexedDB DOM types through the same standard libs.

Each package has a small `tsdown.config.ts` that imports a shared factory from `scripts/build-config.ts`. The factory fixes ESM, neutral platform for Universal, Node platform for Node packages, ES2023, declaration maps, source maps, treeshaking, and clean output. Runtime dependencies remain external; no dependency is silently bundled into a published library.

Universal lint rules reject imports matching Node builtins and global references to `Buffer`, `process`, `__dirname`, and `__filename`. Dynamic `import('node:*')` is rejected too. Node packages have no such restriction.

The human CLIs are built to JavaScript before execution. Package scripts never rely on Node strip-only TypeScript. The discovered `StreamAbortError` parameter property must also be rewritten or transpiled; the release gate runs each CLI `--help` from packed output.

## 10. Workspace configuration

The root manifest is private and pins:

```json
{
  "private": true,
  "packageManager": "pnpm@11.25.0",
  "engines": { "node": ">=22.12" }
}
```

`pnpm-workspace.yaml` uses these normative settings:

```yaml
packages:
  - packages/*
  - tests/fixtures/*

catalog:
  '@a2a-js/sdk': 1.1.0
  '@arethetypeswrong/cli': 0.18.5
  '@changesets/cli': 3.0.1
  '@modelcontextprotocol/client': 2.0.0
  '@modelcontextprotocol/node': 2.0.0
  '@modelcontextprotocol/server': 2.0.0
  '@opentelemetry/api': 1.9.1
  '@opentelemetry/api-logs': 0.221.0
  '@types/node': 26.4.0
  '@vitest/browser-playwright': 4.1.11
  dependency-cruiser: 18.2.0
  eventsource-parser: 4.1.0
  playwright: 1.62.1
  publint: 0.3.24
  tsdown: 0.22.14
  turbo: 2.10.12
  typescript: 7.0.2
  vitest: 4.1.11
  wrangler: 4.127.1

catalogMode: strict
catalogPrune: true
saveExact: true
saveWorkspaceProtocol: rolling
sharedWorkspaceLockfile: true
disallowWorkspaceCycles: true
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
minimumReleaseAgeIgnoreMissingTime: false
trustPolicy: no-downgrade
trustLockfile: false
blockExoticSubdeps: true
strictDepBuilds: true
allowBuilds:
  esbuild: true
  workerd: true
```

All resolution pins, including API-only peer-development dependencies and fixture tools, are listed above. Public peer declarations use their documented compatibility ranges, while workspace development installs resolve through these exact catalog entries. `allowBuilds` started empty. The first clean install stopped on the required `esbuild@0.28.1` and `workerd@1.20260828.1` binary-selection scripts; their exact package/version/source/script/integrity and review expiry are recorded in `docs/dependency-policy.md`. No wildcard approval or `dangerouslyAllowAllBuilds` is permitted.

CI runs `pnpm install --frozen-lockfile`. A dependency upgrade is its own changeset/PR, updates the lockfile, runs `pnpm audit --prod`, records material supply-chain changes, and passes the packed runtime matrix.

The configuration follows current pnpm behavior documented at [workspace protocol](https://pnpm.io/workspaces), [catalogs](https://pnpm.io/catalogs), [dependency-resolution security](https://pnpm.io/settings/dependency-resolution), and [build-script approval](https://pnpm.io/settings/build).

## 11. Task graph

Turbo tasks are deterministic and write only declared outputs:

```text
clean
lint
typecheck
build       depends on ^build
test:unit   depends on ^build
test:contract depends on build
test:edge   depends on build
test:browser depends on build
test:node   depends on build
pack        depends on build
test:pack   depends on pack
check:graph
check:publint depends on pack
check:types depends on pack
check:supply-chain
```

`check:graph` fails on dependency cycles, undeclared imports, Universal→Node edges, provider→agent edges, or core→observability edges. `check:publint` uses `publint@0.3.24`. `check:types` uses `@arethetypeswrong/cli@0.18.5` against each tarball.

`check:supply-chain` parses the committed lockfile and package manifests. It fails a runtime dependency without registry integrity, any git/URL/file dependency, non-exact direct pre-1.0 runtime resolution, an unreviewed lifecycle script, or a runtime license outside `Apache-2.0`, `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`, `BlueOak-1.0.0`, `CC0-1.0`, and `Unlicense`. Compound SPDX expressions must resolve entirely to allowed choices. Any expansion requires a reviewed legal/security rationale in `docs/dependency-policy.md`. The check also runs `pnpm audit --prod`; findings are triaged in that policy file and high/critical findings block release. The check never downloads or executes a package merely to inspect a manifest.

## 12. Runtime conformance matrix

Tests install tarballs, never workspace source aliases, so missing files and wrong exports are visible.

| Gate | Packages | Required evidence |
|---|---|---|
| standards-only import | every Universal package | imports with `Buffer` and `process` unavailable; no Node builtin in emitted closure |
| Cloudflare Worker | core, agent, providers, observability, fetch, MCP | actual request/stream, abort, crypto ID, MCP round-trip |
| Chromium module | core, agent, providers, browser observability, MCP | import, model mock stream, IndexedDB recovery |
| Node | every package | import and representative operation on oldest supported Node |
| package | every tarball | publint, types check, exports/files/license/readme |
| graph | whole workspace | no cycle and no forbidden runtime elevation |

The committed runtime spike is converted into a repeatable contract test. A2A remains in the Node column until its binary test passes with Node globals removed.

## 13. Release process

Changesets config uses one fixed group containing all public packages, `baseBranch: "main"`, `access: "public"`, `updateInternalDependencies: "patch"`, and `bumpVersionsWithWorkspaceProtocolOnly: true`.

Release ordering is computed from the acyclic workspace graph. CI performs:

1. clean checkout and frozen install;
2. all static/unit/runtime/packed gates;
3. `changeset status` and version consistency check;
4. npm authentication and scope-ownership preflight;
5. dry-run pack inspection for every public package;
6. publish with npm provenance and immutable tag;
7. install the published versions into fresh Edge and Node smoke projects.

The scope gate is fail-closed: `npm view` returning 404 proves a package is unpublished, not that the authenticated account owns the scope. Publishing is forbidden until npm authentication confirms the scope. No code or package rename is needed while waiting because local workspace names are already final.

## 14. Rollback and migration safety

- Package extraction commits are graph-topological and independently revertible.
- Until the final cutover, the old root source is not deleted; compatibility entries first point to new packages and pass tests.
- npm lock conversion occurs in one commit after a clean pnpm install and lock review. `package-lock.json` is removed only after CI proves pnpm reproducibility.
- No package is published during structural migration. All new manifests stay private.
- The first prerelease uses a prerelease tag. Stable `latest` is changed only after packed Edge, browser, Node, provider integration, and compatibility gates pass.
- If a package extraction fails, revert only that package commit; do not copy shared code to bypass the dependency rule.

## 15. Definition of done

The monorepo migration is complete only when:

- all package names, manifests, exports, source ownership, and graph edges match this document;
- the root and every package build from a frozen install;
- no Universal emitted closure contains or requires Node globals/builtins;
- MCP strict Worker round-trip passes and A2A is correctly classified Node;
- current public import paths pass from the compatibility tarball;
- provider plugins install/dispose transactionally;
- the exact `eventsource-parser` dependency exists only in provider-http;
- all packed, type, graph, supply-chain, unit, Edge, browser, Node, and selected live integration gates pass;
- implementation-ledger evidence fields are filled with commit IDs and command outputs;
- no unresolved implementation marker, placeholder runtime classification, or unanswered architecture decision remains in release-facing docs.
