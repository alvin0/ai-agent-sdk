# I6 human harness migration evidence

Recorded: 2026-09-05

The hermetic Edge and Node consumers now use the public `createAgentRuntime`
composition API and exact selected capability packages. They do not use any
removed facade.

Edge evidence:

- `test-human/edge-chat/app.ts` is the Web-standard worker and
  `scripted-fixture.ts` contains the explicitly labelled offline provider.
- One `(trusted principal, conversation)` key owns one session; mode is a
  bounded `additionalInstructions` overlay and is not part of identity.
- Every SSE envelope carries schema version, run ID, monotonic sequence, type,
  and exactly one complete/failed/aborted terminal.
- The response stream owns cancellation, waits for session idle with a deadline,
  and observes the independent report.
- Host and provider-native tools use stable call IDs, distinct family labels,
  terminal status, and bounded public JSON projection.
- Missing usage and required observation degradation are distinct visible
  failures; private provider/exporter sentinel text is absent.
- `pnpm human:edge-chat --parallel 4` passed under real workerd and Chromium at
  `test-human/results/edge-chat/run-2026-09-05_06-14-21-605/summary.json`.

Node evidence:

- The harness composes the core runtime, filesystem skill-provider plugin, MCP
  stdio `ToolSource`, and owned JSONL runtime exporter.
- Runtime is created before MCP and supplies its bound lifecycle logger. Runtime
  closes before the borrowed MCP connection; its close report is retained
  independently.
- Recovered checksum-framed records prove balanced MCP connect, catalog-refresh,
  and active-run tool-call logical/attempt evidence without changing token totals.
- Failure probes cover missing usage, required observation degradation, and
  cancellation with no unsettled runtime work.
- The migrated run passed at
  `test-human/results/node-codex/final-migrated/summary.json` with 692
  authoritative tokens, eight tool calls, filesystem skill/resource loading,
  confined file creation, `node --check`, MCP product 437, snapshot resume, and
  durable recovery.

This I6 record intentionally asserts only the migration. The later I8 manual gate
now supplies the separate real-agent/authenticated evidence; see
[I8 release gates](./I8-release-gates.md) and the
[final gap matrix](./I8-final-gap-matrix.md). Direct workerd-to-Codex transport
remains a recorded negative and must not be inferred from the passing test-relay
journey.
