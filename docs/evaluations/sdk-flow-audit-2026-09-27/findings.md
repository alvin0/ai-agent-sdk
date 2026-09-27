# SDK flow and edge audit — 2026-09-27

This audit covers the current `improve-sdk` worktree and its package consumers,
including the opt-in context optimization changes. It preserves the existing
policy, approval, scheduler, cancellation, accounting, history and execution-store
contracts. No commit, publication or deployment was performed.

## Additional defects reproduced and corrected

| Boundary | Failure before correction | Final behavior |
| --- | --- | --- |
| Queued steering before maintenance | Application hooks and regular compaction saw stale messages. A deliberately filtered delivered message could then be reinserted as unseen steering. | Deliver queued input before both readers; bind the projection to the refreshed input identity. |
| Shared projection decisions | Two parallel sessions returning the same frozen `StepDecision` overwrote each other's input identities; a filtered private message reached a model request. | Each preparation receives its own decision identity and input baseline. |
| JavaScript async fusion callbacks | A rejecting acceptance Promise terminated a strict Node process. Async argument mapping returned the wrong failure contract. | Reject Promise results, consume their rejection, preserve completed receipts and stop subsequent execution. |
| Portable no-follow smoke | Local MCP HTTP was rejected by the secure HTTPS default; browser import maps omitted transitive core exports. | Explicitly allow HTTP only in the loopback fixture and supply its core export mappings. SDK transport defaults remain intact. |

The red regression logs are retained. The new session regressions exercise actual
provider-bound request preparation; the fusion regressions run a separate Node
process with `--unhandled-rejections=strict`, execute child tools through the real
runtime and inspect receipts. Earlier optimization edge coverage remains in
`../context-optimization-edge-audit-2026-09-27/findings.md`.

## Validation and evidence

All 26 packages were built and their package-owned tests and packed consumers
were run. Package suites overlap the root suite and must not be added to its
test count. The final changed core is rebuilt and checked separately after the
last correction; other package sources did not change during that final step.
See `checks.json` and `logs/` for the final counts and exit statuses.

- Root suite: **3,146 tests passed in 243 files**.
- Package-owned test scripts: **26 passed** (25 Vitest suites and the
  observability-browser real Chromium recovery test).
- Packed consumers: all **26 packages passed**; final changed core also passed
  its standards, Node, Chromium, Worker and TypeScript matrix after rebuilding.
- Real Codex integration suite: **23 tests passed in four files**, after the
  fusion/queued-input fixes. The subsequent shared-projection identity fix was
  checked separately by the final root suite and live parallel-session case.
- Final optimization lifecycle: **five live cases passed**; a final typed
  fixture repeat also checked shared projection with both real model requests.

Additional gates cover workspace/CLI/root typechecking, publint and declaration
resolution, dependency/runtime/agent ownership boundaries, deliberately invalid
boundary fixtures, supply-chain integrity/licenses, documentation and human-test
command declarations. Actual sandbox acceptance ran on macOS Seatbelt; the
recorded fuzz run used 5,000 algebra and 250 backend cases. The no-follow matrix
ran Node, Chromium, workerd and the verified official Deno 2.9.6 binary.

| Flow | Retained evidence and oracle |
| --- | --- |
| Team lifecycle | `team-conformance/`: 33 controlled public-API cases, including ownership, completion, race, policy and pagination. |
| Native team with real Codex | `team-native/`: native spawn, two actual measurements, dependent worker and exact final calculation all checked. |
| Real sample HTTP/SSE | `chat-live/`: 16 flows checked actual files, shell output, steering, dynamic teams, parallel sessions, paging, denial, cancellation and recovery. Disposable DB/workspace; no user project files used. |
| Approval identity/persistence | `feedback.json`: allow/deny/abort, SDK ID distinct from provider ID, stale ID rejection, single-use resolution, persisted pending cleanup and recovery. |
| Codex SDK integration | `logs/codex-integration-final.log`: live transport, usage, tools, structured output, abort/reuse, compaction/recall, parallel sessions, follow-up and budget finalization. |
| Optimization lifecycle | `optimization-lifecycle/`: two full requests, pointer/chunk retrieval, archive and milestone recall, JSON resume with a fresh controller/store, guarded reducer and raw fallback, queued-input redaction before a real provider. Host retires inventory access to prevent fresh reads from satisfying recall. |
| Action fusion | `action-fusion/`: real temporary file edit plus actual Node assertion, atomic/fused request and receipt counts, provider usage and extractive reducer evidence. |

The sample's generated Next configuration was restored and its disposable server
stopped. `chat-loaded-module.json` records that its loaded module contained the
new projection binding. Checks that rebuild `dist` were sequenced before
consumer tests, after an initial orchestration mistake caused transient missing
imports. Those failed mixed build/test runs are not acceptance evidence.

## Interpretation and limits

The fusion fixture demonstrates three model requests/two observations becoming
two requests/one observation, while both runs perform one edit and one subprocess
test. Provider-reported token usage is retained for the measured pair. This is a
functional smoke, not a general latency, quality or cost benchmark.

The final measured pair reported **1,155 → 827 total tokens**. Both usage reports
had complete authoritative coverage. The extractive reducer kept 225 bytes from
the 6,605-byte log; its additional extraction call reported 4,132 tokens.

Observation packing is checked against the actual request surface; raw history
and an archived milestone remain available. A milestone archive must succeed
before its projection is used. Corrupt reducer verdicts restore the original log;
extractive evidence must match original text and line indexes. The extraction
smoke uses the same Codex model, so it does not establish cheaper-model economics.
Applications still own authoritative verdicts, required evidence, archive/store
authorization and retention, and milestone-summary correctness.

One lifecycle repeat returned an incorrect marker-recall answer. It is retained
under `diagnostics/lifecycle-v3-failed/`, not counted as passing. That version did
not retain request traces, so the failing recall phase/cause cannot be proved
from its artifact. The harness now labels phases and retains request traces on
failure as well as success. The traced repeat preserved the marker in both
milestone/resume requests, retained raw history and performed no new inventory
read. A later final-source repeat is recorded separately. No automatic retry
was added to SDK execution to hide the model outcome.

The first live shared-projection fixture removed all input messages. Codex
returned its explicit `INVALID_REQUEST` / HTTP 400 contract for empty input;
neither request contained private text. The diagnostic is retained separately.
The successful fixture replaces filtered input with a public application
message, shares that frozen decision across both sessions, and checks both
answers and absence of private text. A missing `producer` field in that new
fixture was caught by typechecking and corrected; the final types gate passes.

These checks establish the named local runtime and real-provider flows. They
are not an exhaustive proof over all inputs, all providers, hosted deployments
or production workloads. Historical evidence folders retain their original
hashes. `SHA256SUMS.json` binds this report's artifacts to final source/build
inputs; the diagnostic build manifest identifies the earlier live phase.
