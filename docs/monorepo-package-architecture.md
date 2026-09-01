# Monorepo Package and Runtime Architecture Plan

Status: **Accepted architecture baseline; production split not yet implemented**

Last reviewed: **2026-09-01**

Scope: package boundaries, runtime boundaries, provider extensibility, workspace management, dependency policy, and migration gates.

Implementation contract: [`monorepo-implementation-design.md`](./monorepo-implementation-design.md)  
Ordered backlog: [`implementation-todo.md`](./implementation-todo.md)  
Executable evidence: [`implementation-spike-evidence.md`](./implementation-spike-evidence.md)

Non-goal: this document does not itself implement the package split.

## 1. Decision summary

The project should evolve from one package with many subpath exports into a monorepo containing multiple publishable packages.

The split must be driven by **runtime and capability boundaries**, not by the current source-folder layout:

- A Web Standards package must run on Edge, browsers, Deno, Bun, and Node without importing Node built-ins directly or transitively.
- File access, environment-variable access, local processes, stdio, local paths, and persistent JSONL logging are Node capabilities.
- The effective runtime of an application is the strictest runtime required by its reachable package graph: adding a Node capability elevates the application to Node without changing the universal packages beneath it.
- The agent/harness engine stays shared. Node extends it by providing capabilities; it does not get a second implementation of the agent loop.
- Provider integrations plug into stable core contracts without making the core depend on providers.
- Model calls, usage coverage, errors, and exporter health flow through one universal observability contract; durable file/Node exporters remain Node capabilities.
- The root `ai-agent-sdk` export and regular dependency closure remain Universal; legacy leaf shims are optional peers, and Node capabilities require explicit package installation/import.

The local and intended public package names use `@ai-agent-sdk/*`. All scoped packages remain private until an authenticated release preflight proves npm scope ownership; a 404 from `npm view` is not ownership evidence.

The detailed accounting and delivery design lives in [`observability-and-usage-architecture.md`](./observability-and-usage-architecture.md).

## 2. Why this change is needed

The current project is structurally close to a multi-package repository: it already exposes separate entry points for providers, A2A, MCP, filesystem skills, and request logging. However, all entry points are built under one package manifest, one dependency set, one Node engine declaration, and one release unit.

That causes four problems:

1. A Node engine declaration and Node-oriented dependencies apply to consumers that only need Web Standards code.
2. A runtime-specific implementation can leak into a supposedly neutral bundle through an internal import or shared build chunk.
3. Every provider and protocol currently shares one dependency and release surface.
4. Users cannot express their intended capability set at install time.

The target architecture should let consumers choose among these forms:

```ts
// Edge, browser, Deno, Bun, or standards-only Node usage.
import { defineAgent } from 'ai-agent-sdk'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

// Full Node harness with local capabilities from one facade.
import {
  JsonlObservationJournalExporter,
  defineAgent,
  fileSystemSkills,
} from '@ai-agent-sdk/node'

// A provider implemented outside this repository.
import { createHttpProvider } from '@ai-agent-sdk/provider-http'
```

## 3. Current-state audit

### 3.1 Package and dependency surface

The current [`package.json`](../package.json) contains:

| Kind | Count | Current items |
| --- | ---: | --- |
| Published package | 1 | `ai-agent-sdk` |
| Public runtime entry points | 11 | root plus provider, A2A, skill, logger, and MCP entries |
| Direct runtime dependencies | 2 | `@a2a-js/sdk`, `eventsource-parser` |
| Optional peer dependencies | 3 | MCP client, server, and Node packages |
| Dev-only tools | 4 | Node types, tsdown, TypeScript, Vitest |

The committed npm lockfile currently contains 156 non-root installed package records: 3 in the production closure (`@a2a-js/sdk`, `eventsource-parser`, and transitive `jose`) and 153 marked dev-only. Seventy-one records are marked optional, mostly platform-specific tooling; “optional” overlaps the production/dev classification and must not be added to those counts.

The published runtime surface is small, but the development and release toolchain is materially larger. Package-level isolation and lockfile policy are therefore both necessary. A dependency should only be visible to the capability that needs it.

### 3.2 Existing runtime boundaries

| Current area | Runtime classification | Reason |
| --- | --- | --- |
| Core contracts, errors, messages, runtime, and stream assembly | Universal | Uses language and Web Stream primitives |
| Agent loop, in-memory history, tools, modes, memory contracts, and tracing contracts | Universal | No local-machine capability is inherently required |
| HTTP provider pipeline | Universal | Uses `fetch`, `ReadableStream`, `TextDecoder`, and Web request/response types |
| SSE framing | Universal, provider-owned | Web compatible, but belongs to the HTTP provider layer rather than agent core |
| OpenAI and Anthropic providers | Universal | HTTP-based, subject to an import-graph check |
| Codex memory auth and fetch-based OAuth | Universal | Does not require the local filesystem |
| Codex file-backed auth | Node | Dynamically imports filesystem/path APIs and reads the process environment |
| Filesystem skills | Node | Uses filesystem, path, OS, process, and buffer capabilities |
| Daily JSONL request logger | Node | Writes local files and resolves local paths |
| Environment credential helper | Node capability | Reading `process.env` is not part of Web Standards |
| MCP stdio/process transport | Node | Uses Node-specific MCP transport packages |
| MCP HTTP client/server | Universal, spike-proven | Strict Worker client/server round-trip passed with `Buffer` and `process` unavailable |
| A2A client/server | Node for the initial release | Strict Worker text serialization passed, but the public raw-binary path called upstream `Buffer.from` |
| Build, test, release, and code generation | Build-time Node | Tooling may use Node without changing a package's runtime contract |

Important rule: **guarding a Node global is not the same as being Web Standards-only**. For example, `globalThis.process?.env` may avoid crashing on Edge, but the feature is still a Node capability and should be provided from a Node entry.

### 3.3 Boundaries that must not follow folders mechanically

The current static import graph contains cycles inside cohesive domains:

- core runtime and stream code depend on each other;
- agent history and the agent loop depend on each other;
- A2A agent definitions and agent definition code depend on each other;
- Anthropic provider code and its protocol implementation depend on each other.

Therefore, “one current folder equals one npm package” would create package cycles. The initial split should keep cohesive cycles inside one package, then reduce internal cycles separately if there is a product reason to expose smaller packages.

## 4. Runtime model

### 4.1 Runtime classes

Every publishable package must declare one runtime class in its README and package metadata:

| Class | Allowed capabilities | Forbidden capabilities |
| --- | --- | --- |
| Universal | ECMAScript, Fetch, Web Streams, URL, AbortController, Web Crypto where explicitly required | `node:*`, `process`, `Buffer`, local paths, filesystem, child processes, stdio |
| Node | Universal APIs plus declared Node capabilities | Undeclared optional runtime behavior |
| Build-time Node | Compiler, bundler, test, release, and code-generation tools | Importing build tools from published runtime code |
| Unverified integration | Isolated pending conformance tests | Advertising Edge/browser support |

Browser-specific UI APIs such as DOM elements are not automatically part of the universal baseline. The baseline should be the Web APIs shared by modern Edge runtimes and browsers.

### 4.2 File-reading rule

Reading a local path is always a Node capability in this architecture.

Universal code may define a capability contract, but it must not implement local path access:

```ts
export interface SkillSource {
  list(): Promise<readonly SkillDescriptor[]>
  read(id: string): Promise<SkillDocument>
}
```

Implementations can then be runtime-specific:

- Node: a filesystem-backed source that accepts local paths;
- browser: an in-memory, `File`/`Blob`, user-selected, IndexedDB, or remote HTTP source;
- Edge: an object-store, KV, database, or remote HTTP source.

This lets web users build a complete harness without pretending that `/some/local/path` is portable.

### 4.3 Runtime closure and elevation

A package declares its **minimum runtime requirement**. The effective runtime of an application is the least environment that satisfies every package reachable from its runtime imports.

```text
Universal + Universal = Universal
Universal + Node      = Node
Node      + Universal = Node
```

This means the SDK is Web Standards-first, not Web Standards-only:

- an Edge application can compose core, agent, HTTP providers, and universal skills;
- a Node application can compose all of those same packages plus filesystem, environment, process, stdio, or local persistence capabilities;
- adding a filesystem skill to the runtime graph intentionally changes the application's deployment requirement to Node;
- the universal core and agent packages remain unchanged and independently Edge-compatible.

Installing a Node package and importing it are different. Merely having it in a lockfile does not change generated code, but importing or re-exporting it from an application's reachable runtime graph makes that application Node-targeted. Consumer documentation should use “add a capability” to mean importing and wiring it, not only downloading a package.

Universal and Node capabilities link through the same contracts:

```ts
import { defineAgent } from '@ai-agent-sdk/agent'
import { webSearchSkill } from '@example/web-search-skill'
import { fileSystemSkills } from '@ai-agent-sdk/node/filesystem'

const agent = defineAgent({
  skills: [
    webSearchSkill,              // Universal implementation.
    fileSystemSkills({           // Node implementation of the same Skill contract.
      roots: ['./knowledge'],
    }),
  ],
})
```

There is no Node-specific agent loop in this example. `defineAgent` consumes a universal `Skill` contract; each implementation declares its own runtime needs.

Composition rules:

- universal packages publish contracts and accept capabilities through explicit constructors, factories, or configuration;
- runtime-specific packages depend inward on those universal contracts;
- a universal package never imports, auto-discovers, or conditionally loads a Node implementation;
- capability registration has no global side effect at module import time;
- a skill implemented only with `fetch` and Web APIs can remain universal even if another skill is Node-only;
- runtime classification is checked over the packed transitive import graph, not inferred from the package name.

This model keeps the packages connected while preventing Node functionality from contaminating consumers that did not choose it.

### 4.4 Dependency-direction rules

The dependency graph must point inward:

```mermaid
flowchart TB
  App[Consumer application]

  Facade[ai-agent-sdk<br/>universal facade]
  Agent[@ai-agent-sdk/agent<br/>universal harness]
  Core[@ai-agent-sdk/core<br/>contracts and primitives]
  Obs[@ai-agent-sdk/observability<br/>bus + traces + delivery health]
  Http[@ai-agent-sdk/provider-http<br/>fetch + SSE transport]
  Protocol[@ai-agent-sdk/protocol-responses<br/>wire contracts]

  OpenAI[@ai-agent-sdk/provider-openai]
  Anthropic[@ai-agent-sdk/provider-anthropic]
  Codex[@ai-agent-sdk/provider-codex]
  A2A[@ai-agent-sdk/a2a<br/>Node]
  MCP[@ai-agent-sdk/mcp<br/>Universal HTTP]
  Auth[@ai-agent-sdk/auth-node<br/>Node credentials]
  Node[@ai-agent-sdk/node<br/>local capabilities]

  App --> Facade
  App --> Obs
  App --> OpenAI
  App --> Anthropic
  App --> Codex
  App --> A2A
  App --> MCP
  App --> Auth
  App --> Node

  Facade --> Agent
  Agent --> Core
  Obs --> Core
  Http --> Core
  Protocol --> Core
  OpenAI --> Http
  OpenAI --> Protocol
  Anthropic --> Http
  Codex --> Http
  A2A --> Agent
  MCP --> Agent
  Auth --> Core
  Auth --> Codex
  Node --> Agent
  Node --> Obs
  Node --> Auth
  Node --> Codex
  Node --> MCP

  classDef universal fill:#dff7e4,stroke:#27763a,color:#102b18;
  classDef node fill:#fde5dc,stroke:#a8401c,color:#3a160b;
  class Core,Agent,Facade,Obs,Http,Protocol,OpenAI,Anthropic,Codex,MCP universal;
  class A2A,Auth,Node node;
```

The diagram records the initial verified classification. MCP HTTP passed the strict Worker spike; MCP stdio remains Node. A2A remains Node until every public text/data/URL/binary path passes the same packed strict-Worker gate.

Agent, registry, retry, and provider code emit through a minimal observation interface owned by `core`. The concrete `observability` package implements that interface and depends inward on `core`; instrumented runtime packages must not depend outward on a particular bus or exporter.

Forbidden directions include:

- core or agent importing a concrete provider;
- a universal package importing `@ai-agent-sdk/node`;
- one provider importing another provider;
- a protocol package importing an agent implementation;
- a package reaching into another package's `src/` or unexported `dist/` path.

## 5. Initial package architecture

### 5.1 Initial public package set

| Package | Runtime | Responsibility | Expected direct runtime dependencies |
| --- | --- | --- | --- |
| `@ai-agent-sdk/core` | Universal | Errors, messages, chunks, usage/coverage and correlation contracts, observation interface, shared runtime primitives | Prefer zero |
| `@ai-agent-sdk/observability` | Universal | Observation bus, processors, delivery health, in-memory/test exporter, trace/log/metric projection | `core` |
| `@ai-agent-sdk/observability-fetch` | Universal | Acknowledged remote delivery over Fetch | `observability` |
| `@ai-agent-sdk/observability-browser` | Browser | IndexedDB durability and page lifecycle integration | `observability` |
| `@ai-agent-sdk/observability-node` | Node | Durable JSONL journal and exact-wire diagnostic logging | `observability` |
| `@ai-agent-sdk/observability-otel` | Universal | Span/metric/log bridge to caller-supplied OpenTelemetry API objects; no owned network exporter | `observability`, OpenTelemetry API peers |
| `@ai-agent-sdk/auth-node` | Node | Environment credentials, project-local Codex file auth, and Codex Node wrapper | `core`, `provider-codex` |
| `@ai-agent-sdk/agent` | Universal | Agent definition, tool loop, modes, memory/history contracts, canonical per-run ledger/report, instrumented agent/tool spans, team orchestration | `core` |
| `@ai-agent-sdk/provider-http` | Universal | Fetch pipeline, authentication hooks, retries, streaming transport, SSE framing, instrumented provider attempts through the core observation interface | `core`; SSE parser decision isolated here |
| `@ai-agent-sdk/protocol-anthropic-messages` | Universal | Anthropic Messages wire protocol and mapping utilities | `core` |
| `@ai-agent-sdk/protocol-responses` | Universal | Shared Responses-style wire protocol and mapping utilities | `core` |
| `@ai-agent-sdk/provider-openai` | Universal | OpenAI mapping and defaults | `provider-http`, `protocol-responses` |
| `@ai-agent-sdk/provider-anthropic` | Universal | Anthropic mapping and defaults | `provider-http`, `protocol-anthropic-messages` |
| `@ai-agent-sdk/provider-codex` | Universal | Codex HTTP behavior plus memory-backed credentials | `provider-http`, `protocol-responses` |
| `@ai-agent-sdk/skill-filesystem` | Node | Filesystem-backed implementation of the shared skill contract | `agent` |
| `@ai-agent-sdk/mcp` | Universal | Fetch-shaped MCP HTTP client/server bridge | `core`, `agent`, MCP client/server packages |
| `@ai-agent-sdk/mcp-node` | Node | MCP stdio and Node HTTP adapters | `mcp`, MCP Node package |
| `@ai-agent-sdk/a2a` | Node | Official A2A client/server integration | `core`, `agent`, `@a2a-js/sdk` |
| `@ai-agent-sdk/node` | Node | One batteries-included re-export facade over Node-appropriate Universal and Node capabilities; excludes browser lifecycle code | Workspace packages only |
| `ai-agent-sdk` | Mixed compatibility; root export Universal | Existing root and ten legacy subpath imports during migration | Regular dependencies are Universal; leaf shim targets are optional peers |

Granular Node packages keep dependency ownership and security exposure visible. `@ai-agent-sdk/node` is a re-export-only convenience facade, not a second implementation. The root `ai-agent-sdk` package preserves all current subpath names, but leaf targets are optional peers that legacy users install explicitly; only its regular dependency closure and `.` export carry a Universal runtime promise, while legacy Node subpaths are labelled explicitly.

The root symbol `apiKeyFromEnv` is the one deliberate compatibility exception: it moves to `auth-node`/`node` because retaining a Node environment reader on `.` would make the Universal claim false. The migration keeps a deprecated alias at the new Node owner and documents the exact replacement import.

### 5.2 Why the root facade must stay universal

Importing `ai-agent-sdk` must never activate or resolve local-machine functionality. This property must hold even if tree shaking is disabled.

Consequences:

- no Node conditional export at the root that silently changes behavior;
- no re-export of Node capabilities from the root;
- no shared bundle chunk containing bare Node built-ins;
- no root-entry re-export of A2A or any Node capability; Universal MCP remains an explicit package.

Node users opt in explicitly through `@ai-agent-sdk/node`.

### 5.3 Package exports

Use a small top-level export for the common path and explicit subpath exports for secondary capabilities. Export maps should be deliberate and exhaustive.

Example shape:

```json
{
  "name": "@ai-agent-sdk/node",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./filesystem": "./dist/filesystem.js",
    "./logger": "./dist/logger.js",
    "./mcp": "./dist/mcp.js",
    "./package.json": "./package.json"
  }
}
```

Do not expose wildcard internals. Consumers should never import `dist/*`.

## 6. Extension package model

### 6.1 Provider plugins

“Plugin” here means an ordinary package that implements public SDK contracts. It must not require a global registry, dynamic code loading, or install-time execution.

There are three extension levels:

1. **HTTP endpoint configuration** — the remote API already follows a supported wire protocol. The plugin calls `createHttpProvider()` with base URL, headers, credential resolver, and model defaults.
2. **New wire protocol** — the plugin implements a public `WireProtocol` contract for request mapping, event parsing, error normalization, and usage extraction, then reuses the HTTP transport.
3. **Non-HTTP or fully custom transport** — the plugin implements the lowest stable `ModelAdapter` contract directly.

The public contracts must cover:

- model invocation and streaming;
- normalized message/content/tool-call events;
- cancellation and timeout semantics;
- retry classification without forcing a retry policy;
- usage and finish-reason normalization;
- capability declaration;
- credential injection without assuming environment variables;
- protocol/provider error provenance.

Provider conformance tests should be published as a test helper or reusable fixture. A provider maintained in another repository must be able to pass the same suite without importing private source files.

Core compatibility should use peer dependencies for independently published extension packages:

```json
{
  "peerDependencies": {
    "@ai-agent-sdk/core": ">=0.1.0 <0.2.0"
  }
}
```

Workspace packages can also use development dependencies for local typechecking and testing. The peer range prevents a plugin from silently installing a second incompatible core instance.

### 6.2 Skills and runtime capabilities

A skill package implements the universal `Skill` contract but independently declares the APIs it needs. The contract does not force all implementations into one runtime class.

Examples:

| Skill package | Uses | Effective package runtime |
| --- | --- | --- |
| Remote search | `fetch`, URL, AbortSignal | Universal |
| In-memory calculator | ECMAScript only | Universal |
| Browser-selected document | `File`, `Blob` through a browser adapter | Browser adapter, not part of the universal baseline |
| Local knowledge directory | filesystem, path, process cwd | Node |
| Shell or code execution | child process, stdio, OS signals | Node |

For the first package split, the `Skill` contract and catalog stay in `@ai-agent-sdk/agent` because they participate in the current agent-domain cycles. If the external skill ecosystem later needs an even smaller dependency surface, they can move to `@ai-agent-sdk/skill` after the import graph is made acyclic.

A third-party skill should normally declare `@ai-agent-sdk/agent` as a compatible peer. A Node skill additionally declares its Node engine and owns its Node runtime dependencies. Neither kind of skill registers itself globally; the application imports and passes it to the agent explicitly.

The same rule applies to memory, storage, logging, tracing exporters, credential sources, sandboxes, and transports: the interface may be universal while each implementation raises the consumer runtime only when selected.

## 7. Lessons adopted from Mastra

Mastra is a useful reference for **repository management and extension topology**, not a drop-in runtime blueprint.

### Adopt

- A workspace grouped by capabilities such as core, integrations, stores, server adapters, and deployers.
- Extensions depending on or peering with core, never the reverse.
- Separate packages for runtime adapters and deployment targets.
- Explicit subpath exports rather than a very large root import.
- A graph-aware task runner for build and typecheck ordering.
- A changeset-based release workflow and automated package validation.
- Central dependency policy, version catalogs, and supply-chain controls.

### Do not copy

- A large core package that declares a Node engine while also carrying browser-safe entries.
- Bundler rules that strip Node built-in imports from selected output as the primary runtime-safety mechanism.
- Node dependencies in a package merely because another entry in the same package needs them.
- Mastra's current package granularity without evidence that this smaller SDK needs the same number of packages.

This distinction matters because the current Mastra core has a Node engine requirement, many subpath exports, and build logic to prevent Node built-ins from leaking into browser-oriented output. For this SDK, separate runtime packages are a simpler and stronger contract.

The architectural lesson from Mastra 0.10 is especially relevant: default storage and logging implementations were removed from core to improve production and cloud compatibility, while extension packages moved toward core peer dependencies. Our filesystem, logger, local auth, and stdio capabilities should follow the same separation principle.

Primary references, pinned to the reviewed upstream revision where possible:

- [Mastra workspace layout](https://github.com/mastra-ai/mastra/blob/733bb9aa28fa35623be50b340b59cd3dd66002c9/pnpm-workspace.yaml)
- [Mastra task graph](https://github.com/mastra-ai/mastra/blob/733bb9aa28fa35623be50b340b59cd3dd66002c9/turbo.json)
- [Mastra core manifest and exports](https://github.com/mastra-ai/mastra/blob/733bb9aa28fa35623be50b340b59cd3dd66002c9/packages/core/package.json)
- [Mastra core build configuration](https://github.com/mastra-ai/mastra/blob/733bb9aa28fa35623be50b340b59cd3dd66002c9/packages/core/tsdown.config.ts)
- [Mastra server package](https://github.com/mastra-ai/mastra/blob/733bb9aa28fa35623be50b340b59cd3dd66002c9/packages/server/package.json)
- [Mastra 0.10 architecture changes](https://mastra.ai/blog/mastra-0.10)
- [Mastra 1.0 core and server-adapter changes](https://mastra.ai/blog/changelog-2026-01-20)

### Supporting reference audits

The local DeepSeek Harness snapshot also supports two useful seams: it separates an abstract filesystem service from its local-filesystem implementation, and it keeps `eventsource-parser` inside the concrete DeepSeek LLM adapter rather than the provider-neutral LLM service. However, its LLM packages still use Node APIs, so it is a reference for capability/plugin separation, not evidence of Edge compatibility. See the reviewed upstream files at commit `dd6322d604e00eec1ba5e0c8541159906a21094a`:

- [DeepSeek filesystem capability](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/fs/fs/package.json)
- [DeepSeek local filesystem implementation](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/fs/fs-local/package.json)
- [DeepSeek provider-neutral LLM service](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/llm/llm/package.json)
- [DeepSeek concrete provider and SSE dependency](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/llm/llm-deepseek/package.json)

The local [Codex Rust workspace](https://github.com/openai/codex/blob/9c7edd4bc39f0314767431e6a5960c95c81aa814/codex-rs/Cargo.toml) snapshot is primarily organized as many crates. It demonstrates mature component ownership, but its crate topology should not be translated mechanically into npm packages for this TypeScript SDK. Runtime purity and consumer install surfaces remain the deciding factors here.

## 8. Workspace and release management

### 8.1 Recommended foundation

Because the repository is still at `0.0.0`, this is the least expensive point to establish the final workspace foundation:

- pnpm workspaces with an exact `packageManager` version;
- `workspace:` ranges for internal development links;
- a central catalog for shared build/test tool versions;
- Turborepo for graph-aware build, typecheck, test, and pack tasks;
- Changesets for release intent and changelog generation;
- fixed/synchronized versions for public packages until the API reaches 1.0.

Synchronized pre-1.0 versions make provider compatibility easier to understand. Independent versioning can be reconsidered after plugin contracts stabilize.

The root package is private and owns only workspace tooling. Published code lives under `packages/*`.

Suggested layout:

```text
.
├── packages/
│   ├── core/
│   ├── observability/
│   ├── observability-fetch/
│   ├── agent/
│   ├── provider-http/
│   ├── protocol-responses/
│   ├── provider-openai/
│   ├── provider-anthropic/
│   ├── provider-codex/
│   ├── a2a/
│   ├── mcp/
│   ├── node/
│   └── sdk/
├── fixtures/
│   ├── edge-consumer/
│   ├── browser-consumer/
│   ├── node-consumer/
│   └── external-provider/
├── docs/
├── pnpm-workspace.yaml
├── turbo.json
└── .changeset/
```

### 8.2 Task graph

Minimum graph behavior:

```text
build      -> dependency packages build first
typecheck  -> dependency packages build first
test       -> local build/typecheck prerequisites only where required
pack       -> build, export validation, and tarball smoke tests
release    -> full test, pack, provenance, then publish
```

Tests should run against both source and packed artifacts. Workspace resolution can hide missing files, incorrect export maps, and undeclared dependencies.

### 8.3 Release policy

- One changeset is required for every public API or behavior change.
- All public packages use a fixed group before 1.0.
- Internal packages are never imported by consumers.
- Deprecated compatibility exports must have a documented removal milestone.
- Publish from CI with npm provenance and immutable version tags.
- A release is blocked if a package tarball contains source, fixtures, secrets, or undeclared runtime files.

## 9. Supply-chain policy

The monorepo split should reduce dependency blast radius, not multiply it.

Required controls:

- exact versions for direct runtime dependencies during pre-1.0 development;
- a committed lockfile and frozen-lockfile installs in CI;
- delayed adoption of newly published packages through a minimum release age;
- a trust/no-downgrade policy where the package manager supports it;
- blocking exotic transitive sources unless explicitly reviewed;
- blocking dependency build/install scripts by default, with a small allowlist;
- automated lockfile diff review, license checks, and advisory scanning;
- runtime dependencies declared only in the package that imports them;
- no dynamic execution of provider plugin code discovered from the filesystem;
- release provenance and two-factor-protected publishing credentials.

### `eventsource-parser`

`eventsource-parser` is not architecturally mandatory. The SSE subset used by the SDK can be implemented internally, but replacing a mature parser transfers protocol correctness and security maintenance to this project.

The 2026-09-01 qualification decision is final for the 0.x line:

- keep it isolated in `@ai-agent-sdk/provider-http`;
- pin its exact version;
- prevent install scripts;
- test fragmented UTF-8, CR/LF variants, multiline `data`, comments, `id`, `retry`, empty events, partial chunks, and malformed fields;
- ensure no other package imports it directly.

The owned candidate and deterministic selection rule chose option 1:

1. keep the pinned external package with supply-chain controls;
2. vendor the reviewed implementation with license and update procedure;
3. write an internal parser and prove it with differential and fuzz tests.

The candidate passed conformance, resource, cancellation, 100,000-partition
differential, and 1,000,000-seed fuzz gates, but failed the three throughput gates
by 71.68%–83.13% against a 20% ceiling. It therefore remains a non-production spike.
See [ADR 0001](./adr/0001-eventsource-parser-ownership.md) and the
[archived report](../spikes/sse-parser/REPORT.md). A transitive `3.1.1` copy belongs
to the optional upstream MCP client closure; it is not another direct SDK owner and
remains covered by the lock/audit policy.

## 10. Enforcement and conformance gates

### 10.1 Universal-package gate

Every universal package must pass all of the following:

- TypeScript compiles with Web/ES libraries and without Node ambient types.
- Static imports contain no `node:*` modules.
- Published JavaScript contains no `process`, `Buffer`, `__dirname`, local path logic, or Node-only dynamic imports.
- The full transitive dependency bundle contains no Node built-ins.
- A packed package installs and runs in an Edge fixture.
- A packed package imports with tree shaking disabled.
- Export maps and type declarations resolve under modern Node, bundler, and browser conditions.

The test must inspect packed output, not only source code. A source-level check cannot detect a Node dependency introduced by a transitive package or bundler-generated shared chunk.

### 10.2 Node-package gate

- Supported Node version is explicit.
- Each local-machine capability is documented.
- Optional capabilities do not run at module import time.
- Filesystem and environment access occur only after an explicit API call.
- No credential or file content appears in logs by default.
- Durable observability sinks expose flush/shutdown health and never hide dropped critical records.
- Packed consumer fixtures cover ESM imports and all public subpaths.

### 10.3 Provider-plugin gate

- A provider in the external-provider fixture builds without workspace-private imports.
- Streaming and non-streaming conformance suites pass.
- Cancellation, tool calls, usage, finish reasons, and provider errors normalize correctly.
- Every logical model call and physical retry attempt is correlated, and missing usage is reported rather than converted to zero.
- Credentials can be provided explicitly; environment variables are never required by the universal provider.
- Core has no import edge back to the provider.

### 10.4 Graph gate

- No package dependency cycles.
- No undeclared or phantom dependencies.
- No imports through another package's private filesystem path.
- The root facade has only Universal regular dependencies; legacy Node leaf targets are optional peers and absent from a root-only install.
- Node-only external dependencies are absent from universal package manifests and tarballs.

## 11. Migration plan

Each phase must land with compatibility tests before the next phase begins.

### Phase 0 — Freeze observable behavior

Deliverables:

- capture current public exports and type signatures;
- add streaming, tool-loop, provider, A2A, MCP, and auth behavior tests where coverage is missing;
- record current package contents and bundle entry behavior;
- classify every source file by runtime and target package.

Exit gate: the current single package can be rebuilt and its observable behavior is covered well enough to detect migration regressions.

### Phase 1 — Establish workspace controls

Deliverables:

- create the private pnpm workspace root;
- add package catalog, frozen-lockfile CI, install-script policy, task graph, and Changesets;
- add package graph and packed-artifact validation;
- do not move runtime code yet.

Exit gate: the original package still builds and tests through the workspace task graph.

### Phase 2 — Extract universal core and agent

Deliverables:

- move cohesive core cycles together into `core`;
- add minimal observation/correlation contracts and per-call accounting to `core`;
- add the canonical per-run ledger/report to `agent` and the concrete universal bus/processors to `observability`;
- move the shared harness/agent engine into `agent`;
- express local capabilities as interfaces where the universal engine needs them;
- keep accounting independent from public event-stream consumption and concrete exporters;
- publish no Node globals or built-ins from either package.

Exit gate: Edge and browser fixtures can define and run a minimal in-memory agent from packed artifacts, and every model call ends with complete/partial/estimated/missing/proven-not-applicable usage coverage.

### Phase 3 — Extract HTTP transport, protocols, and providers

Deliverables:

- move fetch, streaming transport, and SSE ownership to `provider-http`;
- extract the shared Responses-style protocol;
- move OpenAI, Anthropic, and universal Codex behavior into provider packages;
- remove `apiKeyFromEnv` and file-auth behavior from universal providers;
- instrument logical model calls, provider attempts, retries, response IDs, errors, and usage coverage;
- move exact request-body logging behind an explicit high-risk content policy;
- expose provider extension contracts and conformance fixtures.

Exit gate: each provider can be installed independently, and an external fixture provider can integrate without private imports.

### Phase 4 — Extract Node capabilities

Deliverables:

- move filesystem skills, env credentials, durable JSONL observability journaling, Codex file auth, and MCP stdio into their granular Node packages;
- make `@ai-agent-sdk/node` a re-export-only facade over those packages plus the shared Universal capabilities;
- ensure all local I/O happens only after explicit calls;
- add journal recovery, retention, delivery-health, and flush/shutdown tests;
- add full-Node packed consumer fixtures.

Exit gate: the universal transitive graph contains no Node capability, while the current Node harness scenarios remain supported through explicit Node imports.

### Phase 5 — Extract A2A and MCP using the verified runtime split

Deliverables:

- extract MCP HTTP client/server as Universal and keep its committed strict-Worker round-trip as a packed regression test;
- extract MCP stdio/Node HTTP adapters into `mcp-node`;
- extract A2A as Node and keep strict-Worker binary serialization as a labelled negative promotion guard;
- promote A2A only after text/data/URL/binary paths all pass without Node globals.

Exit gate: package metadata and documentation state only verified runtime support.

### Phase 6 — Compatibility facade and prerelease

Deliverables:

- give `ai-agent-sdk` only Universal regular dependencies and optional-peer legacy leaf shims;
- provide migration documentation from every old subpath;
- release prerelease versions from packed, provenance-enabled CI;
- test real installs across Edge, browser bundler, and Node fixtures.

Exit gate: no old import path disappears without a documented replacement, and all acceptance criteria below pass.

## 12. Acceptance criteria

The architecture migration is complete only when:

- an Edge consumer can install the facade plus one provider without installing Node-only runtime dependencies;
- a browser consumer can build a harness with in-memory or injected capability implementations;
- a Node consumer can opt into filesystem, env, durable observability journal, auth-file, and stdio capabilities explicitly;
- every model call, retry attempt, tool/compaction/hook/skill/memory/integration operation, missing-usage state, and terminal error is represented in the canonical run ledger;
- exporter failures and drops are visible through health/flush reports and cannot silently become successful delivery;
- universal and Node skills satisfy the same public skill contract and compose through the same agent API;
- adding a Node capability elevates only the consumer's runtime closure, not the runtime classification of core or agent;
- one shared agent loop powers all three environments;
- an out-of-repository provider compiles and passes conformance tests using public APIs only;
- the root `.` entry's emitted closure and regular dependency graph contain no Node built-ins or Node-only packages;
- package dependency graphs have no cycles;
- every package publishes only declared files and exports;
- supply-chain policy is enforced in CI rather than documented only;
- dependency ownership is visible at package level;
- runtime claims are proven by consumer fixtures.

## 13. Decisions closed by the implementation design

| Decision | Initial implementation choice | Release guard |
| --- | --- | --- |
| npm scope | Local and intended public names are `@ai-agent-sdk/*` | Keep scoped manifests private until authenticated ownership succeeds; do not infer ownership from a registry 404 |
| SSE parser strategy | Retain exact `eventsource-parser@4.1.0` only as a direct dependency of `provider-http` | Candidate failed the predeclared throughput gate; keep lock, audit, script, license, graph, and packed-runtime controls from ADR 0001 |
| A2A runtime claim | Node | Promote only when packed strict-Worker text/data/URL/binary paths all pass without Node globals |
| MCP runtime claim | HTTP client/server package Universal; stdio and Node HTTP adapters Node | Keep the committed Worker round-trip as a packed regression test |
| Node package granularity | Granular capability packages plus one re-export-only `node` facade | No capability implementation may be copied into the facade |
| Compatibility period | Preserve every current import path through the initial migration and 1.0 line | Any later removal is a documented major-version change with a replacement path |

## 14. Decision log

| Date | Decision | State |
| --- | --- | --- |
| 2026-09-01 | Use a multi-package monorepo organized by runtime and capability boundaries | Accepted for implementation |
| 2026-09-01 | Keep the harness engine universal and inject runtime-specific capabilities | Accepted for implementation |
| 2026-09-01 | Derive the consumer runtime from its reachable capability graph; Universal plus Node becomes Node | Accepted for implementation |
| 2026-09-01 | Retain exact `eventsource-parser@4.1.0`; owned candidate failed the mandatory throughput gate | Accepted in ADR 0001 |
| 2026-09-01 | Treat all local file/path access as Node-only | Accepted for implementation |
| 2026-09-01 | Keep the root export Universal and require explicit Node imports | Accepted for implementation |
| 2026-09-01 | Keep observability contracts and the run ledger universal; isolate durable Node exporters | Accepted for implementation |
| 2026-09-01 | Use Mastra as a workspace/extension reference, not as a runtime-purity template | Accepted for implementation |
| 2026-09-01 | Isolate SSE parsing in the HTTP provider package and decide implementation separately | Accepted for migration; pre-1.0 gate recorded |
| 2026-09-01 | Publish MCP HTTP as Universal and A2A as Node based on strict Worker evidence | Accepted for implementation |
