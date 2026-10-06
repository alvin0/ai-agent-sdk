# Changelog

All notable changes to the AI Agent SDK are documented in this file.

## 0.1.10 - 2026-10-06

### Added

- `@alvin0/ai-agent-sdk-decision-adapter`: typed choice, score and boolean decisions, a companion runtime with bounded retry/cancellation, reusable tasks, batching and evidence gates. LLM decisions reuse SDK generation adapters through JSON schema or tool output.
- `@alvin0/ai-agent-sdk-provider-typesafe`: native TypeSafe Jev decisions with SDK credentials, provider-attempt accounting and validated probability evidence.
- Agent-tool integration tests, live acceptance runners and document-selection/tool-routing samples for the decision packages.

### Changed

- All 28 workspace package manifests, root metadata and `SDK_VERSION` move to `0.1.10`; 27 packages are publishable and the private testkit remains unpublished.
- CI and Release validate release documentation and human coverage declarations before publication.

### Fixed

- Decision results reject inconsistent token totals, reasoning counters and overflowing usage using the core SDK's accounting validator.
- TypeSafe attempt reports retain valid billed usage when decision-answer validation fails.
- Packed decision checks use the shared Windows-safe command runner, exercise paths containing spaces, and verify installed packages on Node, browser and Worker runtimes.
- Decision sample privacy canaries comply with the existing privacy test policy. Runtime-boundary diagnostics use portable paths, and the negative fixture matrix includes both decision packages.
- Both decision live commands declare their coverage and artifacts in the human acceptance ledger.
- Packed MCP server checks use stdin EOF for graceful shutdown on Windows and wait for stderr to drain before inspecting the close report.

## 0.1.9 - 2026-10-06

### Changed

- Deep mode now confirms an answer written with no step left to confirm it. When a step, tool-call, loop-guard or report-reserve budget forces the final answer, or the model answers on its last work step, before `submit_result` was accepted, the turn gets a finalize window of `finalizeSteps` more steps (`TurnBounds.finalizeSteps`, session `runtimeLimits.finalizeSteps`, 0–8; deep mode defaults to `2`, basic mode never opens it, a managed-team lead defaults to `0`). Only `submit_result` runs in the window; every other tool, including budget-exempt ones such as `request_user_input`, team messaging and spill reads, is declined. The window does not open while a person's input is queued. The turn still ends with the reason that opened it; unless the window confirms an answer, the original answer is kept (a note about what is missing never replaces it). This can add up to two model calls to such a deep run, which can now end `completed: true` with `stopReason: 'budget-exhausted'`; `completed` remains the success signal. Set `finalizeSteps: 0` for the previous behavior. `TurnEndContext.canContinue` is unchanged. Low-level `runTurn` callers opt in with `RunTurnOptions.finalize`.
- A request that an `onRequestError` hook retries no longer spends a work step (up to 8 free retries per turn), is no longer kept in history (its half-written text and cut-off call arguments were being continued from or rejected by the provider), and can be retried on the last step. The forced final answer and the structured-output finalizer now go through the same hook. Step numbers in events still increase with every request, and `outcome.steps` counts every request.
- `request_user_input` waits up to `userInputTimeoutMs` (session `runtimeLimits.userInputTimeoutMs`, default `maxToolDurationMs`) instead of being cut off by the turn's tool limit, and a wait that runs out is no longer recorded as the person dismissing the question: the model is told there was no answer and continues on stated assumptions, and the run can still complete. Tools that wait for a person can declare `awaitsPerson: true` to be bounded only by their own `timeoutMs`.
- A spent budget now ends with an answer wherever one can be written. New `TurnBounds.maxTurnDurationMs` (session `runtimeLimits.maxTurnDurationMs`, default `'auto'`) is a wall-clock budget for the turn's work, excluding waits for a person: when it passes, no new tool work starts and the turn answers from the evidence it has (`budget-exhausted` / `time`) instead of a host having to cancel it with nothing. A model round already in flight is not interrupted. `ExhaustedBudget` gains `'time'`; exhaustive switches over it need a case.
- A forced answer that comes back empty, or only as a call to a tool it cannot use, is asked for once more with tools off; if it still has no answer the turn ends as the budget's stop (`budget-exhausted`, empty text) rather than as a run error. A broken provider stream is reported as that stream error, never masked by an invalid call in what it left behind.
- When the finalize window keeps the original answer, that answer is also re-appended as the last assistant message, so the session's `message`, the stream and a reload agree with `text`.
- The `request_user_input` wait limit holds even for a broker that ignores its abort signal; an answer arriving after the limit is ignored.
- `InteractiveUserInputBroker.resolve()` returns `false` and keeps the question open when the response does not answer exactly the questions asked, instead of using the question up on an answer the run then rejects.

### Fixed

- Responses streams preserve usage attached to `response.failed`, so a billed failed finalizer cannot bypass the token budget by retrying.
- Finalizer retries and the retry for an empty forced answer count the latest call's usage before starting another request, so they cannot bypass the hard token budget.
- Cancellation during a forced-answer or structured-output retry hook ends the turn as aborted and records the interruption marker.
- A forced answer that remains empty after its retry reports `forcedFinalAnswer: false`.
- Reasoning-prefix buffering preserves repeated chunk object references and validates its cap before opening a provider stream.
- Workspace build, typecheck and package-test scripts use portable quoting so their package filters also run on Windows instead of silently selecting zero packages.
- Tarball checks invoke npm and Wrangler through their JavaScript entries on Windows, preserving argument boundaries and avoiding executable shim failures.
- Restoring an answer after an unconfirmed finalize window preserves its original app or model provenance, so sanitized answers remain valid in persisted history.
- A user-input broker's promise is observed before publishing the question event, preventing late rejections from becoming unhandled when timeout wins during event backpressure. Abort listeners are removed when the wait ends.
- The turn's time budget excludes only intervals spent solely waiting for a person. Sibling tool work still counts, including work that overlaps a parallel question wait.
- A tool call whose body never ran (declined by a budget, denied by an interceptor or approval, answered from this turn's earlier identical result) no longer voids an accepted `submit_result`. `tool-result` events carry scheduler-owned `declined`, `recovered` and `dispatched: false` flags, which tools cannot set. A submission must still be the only performed call in its own step.
- A forced final answer that also emits a tool call keeps its answer instead of failing the run with `INVALID_TOOL_CALL`, when the stream ended normally and there is answer text: provider-labelled answer text, or unlabelled text written after the call. Unlabelled text before the call is its preamble and stays commentary, so "let me search…" never becomes the answer; such rounds, and rounds whose stream failed, still fail as before.
- The deep self-check gate no longer stops prompting early after retried requests.
- A hook that is waiting out a retry backoff when the run is aborted ends the turn as aborted, with the interruption marker, instead of throwing.
- A failed or interrupted round that produced no text no longer erases an earlier round's text; a forced round with no message no longer reuses earlier narration.
- The Responses serializer drops reasoning items with neither an id nor encrypted content (left by a stream that failed mid-thought), which made every later request in the conversation fail.
- A Responses `response.failed` with no error body (common from Codex under load) names the response id and status in its message.
- The step reminder is no longer sent inside the finalize window.

### Added

- `RuntimeAgentResponse.endReason`: the full terminal `TurnEndReason` behind `stopReason`.
- `withRetry(adapter, { bufferReasoningPrefix })`: keeps an attempt retryable while it has only streamed reasoning, by holding reasoning chunks until the first answer or tool chunk. Off by default.
- `withoutRunReport(event)`: strips the run report from terminal `usage`/`error` runtime events before a host forwards them to a browser or another tenant.
- `BeforeStepContext.workStep`, `phase` and `finalizing`, so host cues tied to the step budget can follow work steps and skip the forced answer and finalize window.

### Documentation

- Provider `retryPolicy` options state that they only classify failures; retries run when the adapter is wrapped with `withRetry`. The model round timeout and provider request/idle timeouts are not effort-aware; hosts running high reasoning effort should raise them together.

### Release scope

- All 26 workspace package manifests, root metadata and `SDK_VERSION` move from `0.1.8` to `0.1.9`; 25 packages are publishable and the private testkit remains unpublished.
- Merging into `main` triggers the guarded Release workflow to publish npm packages after its checks pass.

## 0.1.8 - 2026-10-05

### Fixed

- At the exact-repeat tool limit, the loop can reuse the immediately preceding successful result in the same turn without dispatching the tool again. Each recovered call keeps a distinct history/event pair, a model-visible `duplicate_of` notice, `recovered`/`duplicateOfCallId` result metadata and `sdk.tool.recovered` span attribution.
- Repeat admission applies per call in mixed batches: eligible repeats recover, ineligible repeats decline, and fresh siblings retain normal quota, authorization, concurrency and cancellation checks. Recovered calls spend no dispatch quota. A recovered repeat alongside fresh dispatches no longer forces a premature final answer.
- A round containing only recovered calls can take one ordinary model replan per exact key within existing step, token and tool bounds. A further exact repeat still exhausts the guard. Recovery stays cancellation-safe and cannot cross an intervening call or failure, reuse declined or budget-exempt calls, or reuse results with additional context or turn-completion semantics. Mixed declined rounds and other exhaustion guards retain their stop behavior.
- Terminal embedding provider failures preserve available HTTP status, retry delay and request id through the retry wrapper and `normalizeModelFailure()`. `EmbeddingError.failure` exposes a validated, frozen `ModelFailure` envelope and accepts its optional provider facts through `EmbeddingErrorOptions`; existing embedding errors keep their identity. Retry policy, backoff, inputs and vectors are unchanged.
- The two private Next.js web samples move the catalog pin from `16.3.4` to `16.3.6` to address [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j), the `next/og` ImageResponse remote-code-execution advisory. Next.js is a sample dependency and is outside the published SDK runtime dependency graph.

### Release scope

- All 26 workspace package manifests, root metadata and `SDK_VERSION` move from `0.1.7` to `0.1.8`; 25 packages are publishable and the private testkit remains unpublished.
- See [upgrading from 0.1.7](docs/upgrading-from-0.1.7.md) for recovery limits and embedding diagnostics. Merging into `main` triggers the guarded Release workflow.

## 0.1.7 - 2026-09-30

### Fixed

- Managed-team coordination notices and automatic worker reports wake the lead without invalidating an accepted self-check. Explicit agent messages and delegated tasks still invalidate it. Invalidation notices distinguish new input from substantive tool work.
- A successful empty model round clears earlier answer text, so an empty response to steering cannot complete a basic-mode run using the previous answer.
- Live Codex kept-answer tests distinguish the initial answer from the final control reply, avoiding conflicting exact-output instructions while still requiring a real marker response.
- `submit_result` rejects duplicate submissions and batches containing substantive sibling tools. Steering after an accepted submission requires a new self-check.
- The unchanged-answer marker is reserved across all modes, recognized across text blocks, and removed from answers with additional text. Stripped answers stream their remaining text and their message events share the persisted replacement's identity. Terminal errors cannot return a previous raw marker. `assistant-replacement` identifies a kept or corrected draft for live consumers.
- Stop in deep/HIL mode records interruption and closes pending question events. Self-check reminders are not appended when the turn cannot continue.
- Empty model replies and failing tools no longer append empty messages. Basic-mode empty, whitespace-only and reasoning-only replies are incomplete; tools that explicitly conclude a turn retain their completion semantics.
- Queued input is checked against aggregate history capacity before admission. App notices do not create unanswered input, HIL answers invalidate old drafts, and skipped team wakes refresh the member's last outcome.
- Deep mode and delegated agent runs no longer keep a draft after a newer user or agent request. The self-check and following model turn recheck for steering, including input queued during `submit_result`. If a model still sends the unchanged-answer marker, the SDK asks for a full answer and does not record it as a kept answer. Steering received before the draft still allows keeping that draft.

### Added

- `RuntimeAgentSession.hasUnansweredInput()` and `runPending()` expose late input left after a terminal round so applications can schedule recovery.

### Changed

- User or team input left unanswered after the last model round makes the run incomplete, including an `agent-message` delivered at that boundary.

### Release scope

- All 26 workspace package manifests, root metadata, and `SDK_VERSION` move from `0.1.6` to `0.1.7`; 25 packages are publishable and the private testkit remains unpublished.
- Merging into `main` triggers the guarded Release workflow, which publishes npm packages after its checks pass.

## 0.1.6 - 2026-09-29

### Changed

- The Release workflow now creates the `v<version>` GitHub tag at the published source commit after the npm publish step succeeds. Dry runs create no tag; retries and later commits preserve an existing tag.

### Fixed

- `RuntimeAgentSession.inject()` no longer throws `Cannot inject while a runtime session is active` while a run is in flight. Steering reaches the underlying session, which queues it until the in-flight round finishes and delivers it in arrival order. `reset()` and starting a second run mid-run still refuse.
- A person's input sent while the final answer is being written is answered in the same run: the loop delivers it after that answer and runs one more round, instead of leaving it for a later `runPending()` (a run with no steps left still leaves it for `runPending()`). Previously the person saw the steer accepted and never answered. Team deliveries keep their contract: queued behind the answer and processed once by the wake-up. The wake-up now skips a member whose run already answered everything, so a steer and a team message arriving together cost no extra model call (`TeamSessionPort.hasUnansweredInput`, optional; `AgentSession.hasUnansweredInput()`).
- Deep-mode kept answers: the `assistant-text` event of a kept reply described the raw marker message (its text and id). It now carries the stand-in answer, and the live `assistant-message`, `assistant-text` and the history replacement share one message identity.
- Deep mode no longer presents `UNCHANGED_ANSWER_MARKER` as a completed answer when there is no earlier answer in the run to keep (a model can imitate an earlier run's accept). The marker is not streamed; the model is asked once for the answer itself, and a repeat ends the run with an empty, incomplete result.
- A confirming reply that is cut off (aborted, errored, out of tokens) while its text is still only the start of the marker no longer streams that fragment or replaces the earlier answer with it; the earlier answer stands and the run reports the interruption as incomplete.
- A confirming reply from a reasoning model (reasoning block plus the marker) is recognised as the marker; previously the extra block made it stream to the user. Its reasoning is still emitted, now under the stand-in message id.
- A failed history write while replacing a deep-mode marker now fails the run instead of reporting completion with a result that disagrees with persisted history.

### Release scope

- Behavioral changes are in `@alvin0/ai-agent-sdk-core`. All 26 workspace package manifests, root metadata, and `SDK_VERSION` remain at `0.1.6` for this release. The private testkit remains unpublished.

## 0.1.5 - 2026-09-29

### Added

- Added opt-in context optimization through `createContextOptimizer`: repeated tool observations can be packed behind a retrieval locator, and host-verified completed milestones can be projected after archival and a positive savings check. Raw history remains intact.
- Added `createModelEvidenceReducer`, `reduceEvidence`, and `diagnosticLineNumbers` for exact-line log reduction with host-supplied status/evidence validation and full-output fallback.
- Added experimental program tools through session-level `experimentalPrograms`, `experimentalNestedToolPort`, and tool-level `experimentalOutputSchema`. Child calls use the existing policy, approval, checkpoint, cancellation, and shared tool-budget boundaries; `parentCallId` identifies them to interceptors and checkpoints.
- Added `defineActionFusion` for an exclusive sequence of host-selected tools without an intermediate model round. Applications supply argument mappings and success predicates; completed mutations are not rolled back when later validation fails.
- Added managed-team options `autoLeadCoordination`, `workerTeamTools`, and `requireWorkerText`, plus `beforeStep` request-only projection through `StepDecision.messages`.

### Changed

- Agent `commentary` now defaults to `auto`, leaving narration style to caller instructions and the model. Set `commentary: 'concise'` to retain the previous default.
- Managed-team prompts describe lifecycle and delivery semantics; application instructions now own planning, delegation, and synthesis strategy. Automatic lead coordination remains enabled by default.
- Clean worker completion with empty text is now accepted by default; set `requireWorkerText: true` to preserve the previous validation rule. `workerTimeoutMs` measures active execution rather than time queued for dependencies or setup.
- Managed-worker `writes` must be workspace-relative and cannot escape the workspace. `maxDependencyReportBytes` must be at least 4; its default remains 8 KiB.
- Mid-round `session.inject()` input is queued until the round boundary. Its immediate receipt is provisional rather than an eventual persisted history sequence; snapshots preserve queued input without changing the v1 schema.
- See the [upgrade guide](docs/upgrading-from-0.1.4.md) for compatibility notes. Existing import routes and ordinary agent/tool/session calls remain available; the new optimization and program APIs require explicit application configuration.

### Fixed

- Fixed deep/deep-human-in-loop modes rewriting an already-complete answer after an accepted `submit_result` self-check finds nothing to add. The accept instruction now tells the model it may reply with the new `UNCHANGED_ANSWER_MARKER` (exported from `@alvin0/ai-agent-sdk-core/agent`) when its earlier answer still stands; `runAgent` recovers that earlier text for the run's outcome and, via a history `replace` entry, for anyone re-reading the stored history afterward. A model that does have something to add or correct still writes the answer in full, exactly as before.
- Kept-answer control replies no longer leak into assistant text streams; terminal events and `onTurnEnd` hooks receive the restored answer. Premature control replies cannot overwrite the retained draft.
- Steering queued during a failed model checkpoint is delivered before recovery hooks and the retry request, including steering injected by the retry's `beforeStep` hook.
- Task memory now explicitly treats retained objectives as background when newer user instructions conflict, preventing the original objective from overriding steering or later requests.
- Credential writers briefly retry Windows delete-pending lock errors so concurrent commits retain revision-conflict semantics; persistent permission errors still surface promptly.
- Managed dependencies retain producer identity across closure/address reuse, write claims survive running follow-ups and bounded close, and incomplete A2A responses are recorded as failed. Full dependency evidence remains retrievable after preview truncation.
- Hook timeout cancellation is forwarded to callback signals. Interrupted turns record context for the next request; expired tool-output locators direct callers to existing receipts/current state before repeating an operation.
- Made regression tests and the core packed runtime matrix portable across Windows and current Node versions; Python analyzer parity remains mandatory in CI.

### Release scope

- All 26 workspace package manifests, root metadata, and `SDK_VERSION` move from `0.1.4` to `0.1.5`; 25 packages are publishable and the private testkit remains unpublished.
- Publication follows the guarded Release workflow after merge to `main`; a prepared version is not proof of npm availability.

## 0.1.4 - 2026-09-19

### Added

- OpenAI now supports both Responses and Chat Completions, including per-model wire routing and compatibility controls for third-party gateways.
- Added provider-native prompt caching: stable OpenAI cache keys, Anthropic `cache_control` breakpoints with optional TTL, gateway fallback, and normalized Gemini implicit-cache usage.
- OpenAI, Anthropic, and Gemini now support custom display names, paths, queries, request-body overrides/transforms, contextual headers, and agent-level `providerOptions`; HTTP providers also expose exact `responseLogger` diagnostics.
- Agents can override `contextWindow` and `inputModalities`, while runtimes can define shared model defaults.

### Changed

- **Breaking:** reasoning effort is now agent-level, provider-owned pass-through. Per-invocation effort, SDK validation/defaulting, and `defaultEffort` were removed; Anthropic defaults to `output_config.effort`, with legacy thinking budgets opt-in.
- Removed hard-coded vendor model policies. Unknown models use a 200,000-token context and permissive text/image/document input; output limits are omitted unless configured, except where a protocol requires one.

### Fixed

- Fixed media rejection for uncatalogued models, invalid cross-protocol reasoning formats, and standalone Anthropic/Gemini package typechecking.

### Release scope

- All 26 workspace package manifests, root metadata, and `SDK_VERSION` move from `0.1.3` to `0.1.4`; 25 packages are publishable and the private testkit remains unpublished.

## 0.1.3 - 2026-09-15

### Added

- Added `@alvin0/ai-agent-sdk-sandbox`, a Universal package holding the sandbox contract: the file-effect mode vocabulary, per-call policy resolution, the ordered writable-root algebra both enforcement layers share, exec classification, minted escalation approvals, and the rules that keep a broken sandbox from reading as a denied command.
- Added `@alvin0/ai-agent-sdk-sandbox-node`, the Node enforcement half: bubblewrap and Seatbelt process confinement, an in-process path fence, credential-safe spawn options, process teardown, resource supervision, backend probing, and a dependency doctor.
- Added network reach as a policy axis of its own (`deny`, `loopback`, `allow-all`), enforced by a network namespace on Linux and `(deny network*)` on macOS, and reported separately from the file mode.
- Added `classifyExec`, which reads what a command does — including inside a shell string, a pipeline, or a chain — and maps it to `allow`, `allow-scoped`, `ask-approval`, or `deny` before any enforcement runs.
- Added a read allow-list baseline (`baseline: 'deny'`) enforced by the fence, `openConfinedWrite`/`writeConfinedFile` for check-and-open in a single step, and `superviseConfined` for sampled wall-clock, memory, process, and CPU limits.
- Added English and Vietnamese sandbox documentation, an agent-skill reference, a differential policy fuzzer, and a cross-platform acceptance suite with its own CI workflow.

### Changed

- Documented how the sandbox composes with the agent loop: a `ToolInterceptor` turns a classification into `allow`/`deny`/`ask`, the session's approval broker answers `ask`, the interceptor mints the escalation once a person has answered, and the tool body resolves the policy and confines or fences. Covered in the sandbox guide (English and Vietnamese), the package README, and the agent skill.

### Compatibility

- Both sandbox packages are new at `0.1.3` and change no existing API. Neither depends on `@alvin0/ai-agent-sdk-core`, so they are opt-in and add no dependency to an application that does not install them.
- `SandboxMode` governs file effects only. Network and resources are separate policy fields, and `confine()` reports `full`, `partial`, or `fence-only` enforcement rather than implying it.
- A policy request may only narrow authority. Widening requires an approval minted by `approveSandboxEscalation`, which is spent on first use unless given `scope: 'session'`; parsed JSON is refused.
- There is no Win32 confinement backend: `confine()` fails closed with `SANDBOX_UNAVAILABLE` on Windows, while the in-process fence still applies on every platform.
- Resource limits are sampled, not quota-enforced; a hostile swap of a directory component defeats a check-then-write, and `confine()` refuses `baseline: 'deny'` rather than pretending to enforce it. Each limit is documented where it is measured.

### Release scope

- All 26 workspace SDK packages, root metadata, and `SDK_VERSION` move from `0.1.2` to `0.1.3` to satisfy the existing lockstep release workflow. The private testkit remains unpublished.
- `@alvin0/ai-agent-sdk-sandbox` and `@alvin0/ai-agent-sdk-sandbox-node` are published for the first time at `0.1.3`. Every other package receives the lockstep version update with no behavioral change.

## 0.1.2 - 2026-09-13

### Added

- OpenAI, Anthropic, and Gemini generation adapters/plugins now accept custom endpoint `headers` as a record or synchronous resolver, and `allowInsecureHttp` for explicitly trusted local gateways.
- OpenAI and Gemini embedding adapters/plugins now accept custom headers. Prepared embedding calls retain one header snapshot across all batches.
- Added `getCodexTokens(store, options)` for store-backed token reads with optional automatic refresh, and `getCopilotToken(store, options)` for API-token acquisition with an application-owned cache and explicit invalidation. Both helpers are also re-exported by their Node auth entry points.
- Added a working SQLite credential-store example with tenant scoping, atomic revision checks, and tests for database persistence, refresh, and runtime integration.
- Added English and Vietnamese guidance for compatible gateways and database-owned credentials.

### Fixed

- Preserve the stored Codex account identity when a refresh response omits `id_token`.
- Reject malformed Codex refresh payloads and empty or non-string token fields before committing credentials.
- Honor cancellation while waiting for database reads or a custom Copilot token cache, including hooks that ignore their signal; observe late promise rejections after cancellation.
- Reject empty tenant scopes and unknown provider values in the SQLite example.

### Compatibility

- Custom headers preserve case-insensitive ownership checks: reserved authentication, protocol, transport, and SDK headers cannot be silently overwritten. Credentials remain configured through the provider's auth options.
- Gateway compatibility still requires the matching wire protocol: Responses for OpenAI generation, Messages for Anthropic, and Interactions for Gemini.
- Filesystem storage remains only a Node-wrapper default. Database stores use the existing `read`/`commit` contract; Copilot API-token caching can use custom `acquire`/`invalidate` hooks.
- Codex refresh tokens rotate. Applications must coordinate concurrent refreshers across workers with an account-level lock or shared auth service; revision checks alone do not serialize OAuth requests.

### Release scope

- All 24 workspace SDK packages, root metadata, and `SDK_VERSION` move from `0.1.1` to `0.1.2` to satisfy the existing lockstep release workflow. The private testkit remains unpublished.
- Behavioral/API changes are in `provider-http`, `provider-openai`, `provider-anthropic`, `provider-gemini`, `provider-codex`, `provider-copilot`, and `auth-node`; core also updates SDK version attribution. Other packages receive the lockstep version update.

## 0.1.1 - 2026-09-13

### Added

- Added document input support across the core message contract and the Anthropic Messages, Gemini Interactions, OpenAI Responses, OpenAI Chat Completions, and Codex provider paths, with strict validation and projection rules.
- Added the public embedding API and composition runtime, including model catalogs, request validation, batching, limits, retries, caching, usage accounting, lifecycle observations, and provider conformance tests.
- Added OpenAI and Gemini embedding adapters, including configurable model capabilities and compatibility identities.
- Added `@alvin0/ai-agent-sdk-provider-copilot` with GitHub device-flow authentication, token persistence, model discovery, generation, embeddings, and Node CLI support.
- Added `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` with serialization and streaming translation for text, tools, terminal states, truncation, and usage.
- Added per-invocation model overrides for agent runs.

### Changed

- Reworked `@alvin0/ai-agent-sdk-provider-http` around shared connection, session, JSON, and streaming transport primitives with bounded redirects, timeouts, abort handling, media-type validation, and credential-safe observations.
- Extended provider and testkit contracts to cover embedding and Copilot conformance, generation-oracle fixtures, and SSE/JSON transport equivalence.
- Updated the approved Anthropic SSE oracle for cumulative `usage-progress` snapshots and made main-branch releases gated, lockstep-checked, and safe to retry when a package version is already present on npm.
- Improved provider documentation and model limit guidance in English and Vietnamese.

### Release scope

- All workspace SDK packages move from `0.1.0` to `0.1.1` so the lockstep release workflow can publish a complete, internally compatible package set.
- `@alvin0/ai-agent-sdk-provider-copilot` and `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` are published for the first time at `0.1.1`.
- `@alvin0/ai-agent-sdk-testkit` remains private but carries the same workspace version.

## 0.1.0 - 2026-09-09

- Initial public release of the capability-based AI Agent SDK packages.
