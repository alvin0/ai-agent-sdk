# Implementation Design Spike Evidence

Status: complete for the design baseline  
Evidence date: 2026-09-01 (Asia/Ho_Chi_Minh)  
Branch: `mono-package`

This file records the executable evidence used to close implementation-design decisions. It contains no credential, token, prompt body, or provider response body.

## 1. Toolchain and installed graph

- Node available for verification: `v26.8.1`.
- npm: `12.0.2`.
- pnpm available locally: `11.19.0`; registry version selected for the migration: `11.25.0`.
- Current production closure: `@a2a-js/sdk@1.1.0`, `eventsource-parser@4.1.0`, and transitive `jose@6.2.10`.
- MCP is optional today. Installing all three MCP peers adds `@modelcontextprotocol/{client,server,node}@2.0.0` plus their transitive closure.
- Current lockfile has 156 non-root package records: 3 production records and 153 development-only records. Optional platform variants overlap the development count; they are not 153 packages installed on every machine.

Registry checks on the evidence date selected these exact workspace additions and fixture pins. Existing exact compiler/test pins remain `@types/node@26.4.0`, `tsdown@0.22.14`, `typescript@7.0.2`, and `vitest@4.1.11`.

| Tool | Exact version |
|---|---:|
| pnpm | `11.25.0` |
| Turbo | `2.10.12` |
| Changesets CLI | `3.0.1` |
| publint | `0.3.24` |
| `@arethetypeswrong/cli` | `0.18.5` |
| dependency-cruiser | `18.2.0` |
| Playwright | `1.62.1` |
| `@vitest/browser-playwright` | `4.1.11` |
| Wrangler | `4.127.1` |
| `@opentelemetry/api` | `1.9.1` |
| `@opentelemetry/api-logs` | `0.221.0` (workspace pin; `0.222.0` was rejected by the 24-hour release-age gate) |

## 2. Build and package baseline

`npm run build` passed with `tsdown@0.22.14` and emitted all 11 public runtime entries. `npm pack --dry-run --json` reported:

- 76 packed files;
- 518,710-byte tarball;
- 2,003,902 unpacked bytes;
- no bundled npm dependencies.

The build scan found static Node imports only in the expected current Node entries (`skill-filesystem` and `request-logger`). The Codex entry still contains dynamic `node:fs/promises` imports in its file auth implementation, which is why the design moves that store to a Node capability package.

The initial design verification reran the current unit suite on Linux: 470 of 471 tests passed. The single failure hard-coded `src\\store.ts` while the tool returned `src/store.ts`. Phase F0 standardized all agentcode-returned paths as POSIX-style paths and corrected the assertion. After F0/F1, the complete default suite passed 484/484 tests across 37 files; typecheck, library/CLI builds, dry-run, provider-status, and pack dry-run also passed.

## 3. Real Codex provider verification

The project-local Codex credential store was checked through `npm run provider:codex:status`; it was signed in and valid. Account details are intentionally omitted.

Before F1, the direct human CLI command failed before network dispatch:

```text
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
TypeScript parameter property is not supported in strip-only mode
```

The failing production location was `src/agent/loop/run-turn.ts` (`StreamAbortError`). F1 resolved this by compiling every executable CLI to `.mjs` with a Node-targeted tsdown configuration before execution; CLI smoke tests now exercise the same compiled entry and prove dry-run performs no credential write.

The real provider was then tested through the Vitest integration harness, which transpiles TypeScript correctly:

```sh
npm exec vitest -- run --config vitest.integration.config.ts \
  -t "streams text and assembles a message" --reporter=verbose
```

Result: 1 test passed in 2.962 seconds. The test hard-codes provider `codex` and model `gpt-5.6-luna`, verifies a terminal successful finish, text deltas, an assembled message, and positive input/output token usage. Three unrelated live cases were skipped by the name filter. Request-body logging was disabled for the failed CLI attempt; the integration test does not configure the exact-wire logger.

This closes two decisions:

1. The current Codex adapter and `gpt-5.6-luna` route are reachable with the project-local auth store.
2. Positive usage exists on a successful provider call, but the current public outcome still cannot distinguish a missing usage report from aggregate zero. The new ledger remains required.

## 4. Web Standards runtime spike

The committed fixtures are under `spikes/runtime-compat/`. Both strict workers set `globalThis.Buffer` and `globalThis.process` to `undefined` before exercising the target runtime path.

### MCP HTTP

Using Wrangler `4.127.1` and `@modelcontextprotocol/{client,server}@2.0.0`:

```text
GET /runtime -> 200 {"buffer":"undefined","process":"undefined"}
GET /mcp     -> 200 {"status":"ready","tools":[]}
```

The request performs an in-worker client/server initialization and tool-catalog round-trip using only `Request`, `Response`, `fetch`-shaped transport, Web streams, abort signals, and timers. Decision: `@ai-agent-sdk/mcp` HTTP is Universal. Stdio and Node HTTP adapters remain in `@ai-agent-sdk/mcp-node`.

### A2A

Using `@a2a-js/sdk@1.1.0`:

```text
GET /runtime    -> 200 {"buffer":"undefined","process":"undefined"}
GET /a2a-text   -> 200 (valid A2A text message JSON)
GET /a2a-binary -> 500 TypeError at upstream base64FromBytes / Buffer.from
```

Decision: the initial `@ai-agent-sdk/a2a` package is Node-elevated. It cannot be advertised as Universal while its public `Part` contract accepts raw bytes but the upstream codec needs `Buffer`. A later Universal promotion requires either an upstream release that passes the same strict worker fixture or an owned Web-standard codec with protocol conformance tests.

### OpenTelemetry API bridge

Using `@opentelemetry/api@1.9.1`, `@opentelemetry/api-logs@0.222.0`, and Wrangler `4.127.1`:

```text
GET /runtime -> 200 {"buffer":"undefined","process":"undefined"}
GET /otel    -> 200 {"status":"ready","tracer":"function","meter":"function","logger":"function"}
```

The strict Worker fixture creates/ends a no-op span, records a counter, and emits a log through caller-supplied API surfaces. Decision: the mapping-only `@ai-agent-sdk/observability-otel` package can be Universal. This does not classify any OpenTelemetry SDK or OTLP network exporter; those remain host dependencies and require their own runtime proof.

## 5. `eventsource-parser` decision

The installed and registry-current version is `4.1.0`, exact integrity:

```text
sha512-+DHvQ1wLO//MK+1OZgcuXCbZFKgu3YjKPJt7n98rxX8vezL0ni+7s3ZQiM8bJkUEOk7MsuCycrPLj0FzUNf7Og==
```

Its runtime implementation is Web-standard and isolated behind the SDK SSE parser. Replacing it is technically feasible, but doing so safely requires a WHATWG SSE conformance corpus, split UTF-8/chunk tests, CR/LF boundary tests, retry/id/comment semantics, resource bounds, fuzzing, and differential tests. The implementation default is therefore:

- keep exact `eventsource-parser@4.1.0` during the package migration;
- install with frozen lockfile, release-age/trust checks, registry-only transitive sources, and denied dependency scripts;
- keep the dependency owned only by `@ai-agent-sdk/provider-http`;
- decide vendor/replace only after the replacement gate in the TODO passes.

This is a closed migration decision: removal is not a prerequisite for the monorepo, and accidental spread into core or agent is forbidden.

P0 executable follow-up: `eventsource-parser@4.1.0` reports its configured buffer overflow through the optional `onError` callback instead of throwing automatically from `feed()`. Without an SDK callback, a malicious oversized unterminated event can therefore end as an empty stream. The provider-owned wrapper now throws only `max-buffer-size-exceeded`, continues to ignore forward-compatible unknown fields, and has conformance coverage for BOM, CRLF, split UTF-8, multiline data, comments, unterminated EOF, and overflow. The packed package passed standards-only Node, Chromium, and Cloudflare Worker execution with the dependency exact-pinned in its manifest.

## 6. Evidence limitations

- Local Wrangler is a real Worker isolate/bundler path, but it is not every Edge vendor. Packed-package gates still run on Cloudflare Workers plus an independent standards-only fixture before an initial release.
- The live Codex test proves one successful model call and usage report, not retry, abort, missing-usage, or exporter durability. Those cases are deterministic contract tests in the implementation plan.
- No production architecture change was implemented during these spikes.

## 7. A0 local-team boundary spike

The frozen runtime baseline contains the public `AgentTeam`, `DefinedAgentTeam`, and `ManagedAgentTeam` names, but no replacement symbol names are specified by the architecture. A0 therefore changes source ownership, not runtime identity: `agent/team` is canonical and the old `agent/a2a` source barrel is a deprecated identity-preserving alias. This avoids inventing an undocumented API rename while still separating local orchestration from the official top-level A2A wire implementation.

Before the change, the ownership checker reported `a2a -> define -> a2a`. After introducing `TeamSessionPort` and making `AgentSessionOptions` depend on a structural session-facing control-plane surface, the agent graph has no `define` ↔ `team` cycle; only the pre-existing `loop` ↔ `history` cycle remains for its later owning phase. A dedicated gate rejects concrete define/session-to-team implementation imports, and a negative fixture proves that the old cycle is detected. A compile-time assignment in the team suite proves `AgentSession` satisfies `TeamSessionPort` structurally.
