# I3 MCP public-type portability evidence

Date: 2026-09-05

## Decision and implementation

The MCP 2.0.0 client/server runtime remains pinned. Universal public
declarations now use SDK-owned structural types instead of importing the
upstream root declaration graph, whose shared stdio `ReadBuffer` names the Node
`Buffer` global. The temporary pnpm dependency patches used to diagnose the
problem were removed because an isolated tarball install proved they do not
propagate to consumers.

The client implementation was also split by responsibility. `src/client.ts` is
614 lines; its `api-types`, `public-types`, result, HTTP-security and runtime
helper modules are each below 150 lines. No implementation file added or changed
for this slice exceeds 700 lines.

## Verification

- `pnpm --filter @ai-agent-sdk/mcp typecheck`: pass.
- `pnpm exec tsc --noEmit -p tsconfig.json`: pass after updating the live mode
  spike with its required explicit call config.
- strict target declarations: NodeNext, base Web and full Web all pass with
  `skipLibCheck: false`; Web uses `types: []`.
- `pnpm --filter @ai-agent-sdk/mcp test:pack`: pass. The script installs real
  core/agent/MCP tarballs in isolated directories, compiles a no-Node-types
  consumer with no workspace paths, and runs Node, Chromium and Workerd MCP
  journeys.
- focused MCP tests: 19/19 pass, including real upstream Node `Buffer` stdio
  parsing and HTTP lifecycle behavior.
- emitted `packages/mcp/dist/*.d.ts`: zero `@modelcontextprotocol` imports and
  zero `Buffer` references.
- `pnpm check:supply-chain -- --skip-audit`: 390 integrity records, zero
  findings after removing `patchedDependencies`.

`pnpm check:core-capability-contract` reaches and passes all three strict
declaration checks, then stops at the pre-existing frozen `I2 emitted declaration
closure inventory drifted` gate. That later migration-inventory drift is tracked
separately and is not used to weaken MCP acceptance.
