# I3 portable native no-follow evidence

Status: implemented and verified.

## Implemented boundary

- Provider request dispatch, Codex catalog discovery, Codex OAuth, remote MCP,
  `observability-fetch`, and the Node-bound A2A client use explicit
  `redirect: 'manual'` handling. Product source contains no remaining
  `redirect: 'error'` call.
- Every response rejects redirect status, `opaqueredirect`, an already-followed
  response, or an unexpected final URL before accepting response data.
- MCP validates each next URL before dispatch and removes every caller header on
  an allowed cross-origin hop. A disallowed target is never contacted.
- A2A now uses a bounded five-hop manual loop with endpoint validation before
  each hop, cross-origin header removal, HTTP redirect method semantics, bounded
  body cancellation, and streaming-body replay rejection.
- Codex catalog and OAuth share the domain-local `common/no-follow.ts` helper.

## Installed native-runtime matrix

`scripts/test-portable-no-follow.mts` packs and installs the published closure
for core, provider HTTP, Responses protocol, Codex provider, MCP, and the fetch
exporter into an isolated consumer. It starts one real redirect server and runs
the same public-API fixture with native fetch in:

- Node 26.8.1;
- the checksum-verified official Deno 2.9.6 Linux binary;
- headless Chromium through Playwright;
- workerd through Wrangler 4.127.1.

For provider dispatch, Codex catalog, Codex OAuth, MCP, and telemetry export, the
server asserts exactly one initial request and zero requests to every redirect
target. This server-side count is authoritative even though Chromium developer
events expose the aborted target URL for an `opaqueredirect` response.

Command and result:

```text
pnpm test:no-follow
portable native no-follow matrix passed: Node, deno 2.9.6 (stable,
release, x86_64-unknown-linux-gnu), Chromium, workerd
```

The runner is also part of `pnpm test:edge`. It accepts
`AI_AGENT_SDK_DENO_BIN` for an externally verified Deno installation and falls
back to `deno` on `PATH` when the local verified test binary is unavailable.

## Runtime defect found by the matrix

The first Chromium execution showed four correct boundaries but no telemetry
request. The exporter had captured native `fetch` in an options object and then
called it as `options.fetch(...)`. Chromium correctly rejected that Web IDL call
with `Illegal invocation`; Node and Deno tolerated it. `sendBatch()` now captures
the callable in a local binding before invocation. A receiver-sensitive unit
regression proves it is invoked without the options object as receiver, and the
unwrapped native Chromium matrix passes.

## Focused verification

```text
pnpm --filter @ai-agent-sdk/observability-fetch typecheck
pnpm --filter @ai-agent-sdk/observability-fetch test
13 tests passed

pnpm exec vitest run tests/unit/mcp-http-security.spec.ts \
  tests/unit/provider-codex.spec.ts tests/unit/http-provider.spec.ts \
  tests/unit/a2a-protocol.spec.ts tests/unit/observability-fetch.spec.ts
5 files passed; 122 tests passed

pnpm --filter @ai-agent-sdk/a2a typecheck
pnpm --filter @ai-agent-sdk/provider-codex typecheck
pnpm --filter @ai-agent-sdk/mcp typecheck
```

All modified product implementation files remain below the 700-line limit; the
largest file in this boundary is `provider-http/src/base/http-adapter.ts` at 674
lines.
