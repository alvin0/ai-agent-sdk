# Team-auto completion and research regressions

Team-auto is the `team-dynamic` runtime. Rebuild the SDK and restart the dev
server after runtime changes; the sample imports `packages/core/dist`.

## Fixed mechanisms

- Aggregate token usage now defaults to `maxTotalTokens: 'auto'` in the SDK
  and sample. The former 500,000-token ceiling and 100,000-token sample report
  reserve no longer stop default runs. Numeric ceilings remain opt-in;
  reporting reserves are ignored in auto mode. Usage accounting, explicit
  missing-usage policies, context/output limits and other resource guards remain.
  Historical token-limit outcomes documented below describe earlier settings.
  Verification after this default change: 1,786 unit tests passed, one skipped
  across 146 files; core build, workspace/backend/web typechecks and lint passed.
  Scripted regression cases exceed 600,000 tokens without a default stop and
  confirm an explicit 500,000-token ceiling still prevents further work.

- Token-reserve finalization now carries `trigger: 'report-reserve'` in the
  budget outcome. Worker notices distinguish stopping exploration to retain
  reporting capacity from reaching the hard cumulative token ceiling. Both
  remain incomplete unless the completion gate was accepted; this does not
  hide missing work or silently restart a worker with a fresh spending budget.
  The focused loop/sample/team-report suites passed 104 tests, with core build
  and workspace typecheck passing after this distinction was added.

- `fetch_url` now retains up to 40 HTTPS source links (8,000 total URL/label
  characters), resolves relative links against the redirected URL, and ignores
  script/comment anchors. Previously stripping every anchor removed navigation
  evidence and encouraged repeated guesses at unavailable endpoints.
- Incomplete-worker notices preserve member attribution through the wire,
  persisted transcript and live UI, so focusing a worker no longer hides its
  failure/partial-work warning.
- The sample opts into 30 minutes of stale Codex catalogue metadata on refresh
  failure. A deterministic test reproduces the old loss of `max` after the
  five-minute cache expires and verifies the fallback is bounded. A successful
  refresh remains authoritative.
- Previously the sample reserved 100,000 tokens before its 500,000-token limit
  for a tools-disabled report. `finalReportReserveTokens` defaults to zero in
  the SDK. It is checked after tool work and never overrides hard admission
  limits, explicit stop or cancellation; abrupt usage jumps can still exhaust
  the hard limit before a report is possible.

- Repeat-call detection now counts consecutive identical calls, rather than
  all visits across a turn. Previously, checking the same file after distinct
  edits could decline the final verification as `budget-exhausted`. A failing
  regression reproduced that case before the fix. Alternating multi-step
  cycles remain covered by the separate cycle guard.

- The live stock prompt exposed a worker repeatedly paraphrasing "self-check
  already accepted" after a later `send_message` invalidated its submission.
  Deep-mode reminders now explicitly explain that the old acceptance and its
  no-resubmission instruction are stale. Three unverified answers without
  intervening substantive tool work end the run as incomplete, regardless of
  wording. Progress-only tools do not reset this allowance. Original evidence
  is saved in `.data/market-live/2026-09-08T07-14-29.969Z/medium-loop-reproduction.json`;
  that failing live run was interrupted to stop further usage, not counted as
  a passing test.

- `fetch_url` passes the tool's abort signal to fetch, reads at most 200 KB of
  response bytes, cancels the remaining body and reports truncation. HTTP
  failure pages are failed sources rather than successful research results.
  Requests have a 30-second tool timeout. `fetchedAt` provides the retrieval
  timestamp explicitly; it must not be treated as a publication or price date.

- Safe-prefix recovery also retains native-tool ordering. On cancellation or a
  broken extension, narration before native web search remains commentary;
  findings after the search remain a partial answer. Sparse provider indexes
  are evaluated in stream order, not numeric order.

- When abort or output truncation drops an unfinished host tool call, the SDK
  retains that fact for phase inference. Unphased narration introducing the
  dropped call stays `commentary`; it does not become a partial final answer
  merely because the executable call was removed. Explicit provider phases
  retain their meaning outside the dedicated process phase.

- An SDK-designated structured-output process phase overrides a provider's
  per-generation `final-answer` label, both on streaming deltas and settled
  text. Only the subsequent final-output phase is presented as final output.
- If a lead resumes substantive tool work or receives steering after its last
  answer and never writes a replacement, that saved answer is shown as partial.
  Later worker events and ordinary todo/closure bookkeeping do not invalidate
  the displayed answer. The transcript itself is not rewritten by this view.

- Text phases are per agent/model round. A worker's `final-answer` is its
  report to the lead; a lead can produce another answer after receiving late
  worker results. The team-level final response is the last lead answer for
  that user prompt, once the run finishes.
- The SDK emits `text-end` with the provider block index, authoritative text
  and resolved phase before `step-end`. Consumers must replace the streamed
  snapshot with it, not append its text. This closes the gap where deltas had
  `unknown` phase but block-end/history already held a classified answer.
  The sample forwards this for both lead and member events and persists it.
- Canonical text indexes come from the stream assembler, not a second index
  list. Deltas arriving after a closed block are ignored in the visible stream
  as well as in history. On error, abort or output-token truncation, retained
  text carries `incomplete: true` through the SDK, wire protocol and saved
  transcript; the UI labels a retained lead response as Partial answer.
- An unfinished provider extension no longer discards valid preceding text or
  crashes cancellation while assembling replay metadata. The loop retains the
  safe text/reasoning prefix with incomplete status, discards replay metadata
  for that filtered prefix, and preserves the error/abort outcome. Regression
  cases include sparse indexes and whitespace blocks before the retained text.
- The UI keeps the latest lead answer outside Process even when reasoning or
  a late worker report follows it. Earlier lead drafts and worker reports stay
  in Process. This also fixes existing saved transcripts without rewriting
  their content or treating a worker's final block as the user's final answer.

- `onExhausted: 'continue'` made tool-call limits advisory but also disabled
  the final report at step or repetition limits. A last-step `submit_result`
  could leave a successful self-check with an empty answer. These limits now
  allow one tools-disabled report. Explicit `stop`, cancellation, token limits
  and run accounting limits still prevent additional model calls.
- A reminder with two work steps remaining asks for essential checks, honest
  todo updates and submission. The final report also names unfinished work.
- A submission followed by a failed or empty report no longer counts as deep
  completion. A report at the step ceiling is not proof of task completion:
  deep mode still needs an accepted self-check.
- Failed workers retain available partial text with `succeeded: false`; the
  lead and dependent workers receive it with an explicit incomplete label.
- Team leads and workers now use `maxTurns: 'auto'`; single-agent modes keep
  32 work steps plus the bounded final report. Auto removes the step ceiling
  and retains completion, resource and loop guards. A numeric `maxTurns` still
  supports hosts that want a fixed execution budget.
- Reporting instructions also apply to saved presets. `write_todos` is exempt
  from the tool-call budget. Researcher and analyst roles complement the coding
  roles. Todo completion remains evidence-based; unfinished tasks are not
  automatically marked done at shutdown.

## Local comparison: automatic turn duration

Reviewed the local references on 2026-09-08: DeepSeek Harness `d347e70390`
and Codex `dde85b435b`. These findings describe those checkouts, not every
released version or hosted configuration.

| Runtime | Main-loop continuation | Separate stopping controls |
| --- | --- | --- |
| DeepSeek Harness | `packages/core/agent-loop/src/agent.ts:275` loops while tool work or next-step input remains. No fixed step counter ceiling in this loop. | Abort, rejected pre-step, model errors/max-tokens, concluding tools and turn-stopping hooks. The repeat-tool-reminder plugin is advisory. |
| Codex | `codex-rs/core/src/session/turn.rs:304` loops; `needs_follow_up` combines model continuation and pending input. Context pressure can trigger compaction and continuation. | Cancellation, errors and stop hooks; optional rollout budget tracks usage across the root session tree and raises `SessionBudgetExceeded`. |
| This SDK/sample | `maxTurns` maps directly to loop `maxSteps`; both accept a positive integer or `'auto'`. Sample team leads/workers use auto, single agents use 32. | `onExhausted: 'continue'` relaxes tool-call counts only; numeric step limits and repetition limits allow one final report, subject to hard stops. |

`maxTurns: 'auto'` now provides completion-driven continuation without an
arbitrarily large numeric ceiling. It does not imply automatic success or
unlimited resources. Existing token/ledger limits keep their current scope;
this change does not introduce a pooled financial budget across the team.
Compaction reduces active context; it does not reset cumulative usage.

Regression tests exercise 70 work steps in basic/deep mode, sample lead and
worker reports after 57 steps, runtime composition/session overrides, cloning,
serialization, invalid values, loop detection, token stops and cancellation.
Numeric defaults remain unchanged in the SDK.

## Offline verification commands

```powershell
pnpm --filter @ai-agent-sdk/core build
pnpm build:cli
pnpm exec vitest run tests/unit
pnpm --filter @chat-agents/backend typecheck
```

`team-budget-reports.spec.ts` tests research, coding and analysis workers at
medium/high/max effort using a scripted provider. It checks last-step
submission, partial output on failure, and evidence delivered to the lead.
`agent-modes.spec.ts` and `tool-loop.spec.ts` cover finalization and hard stops.
`chat-agents-modes.spec.ts` checks the sample's actual 32-step configuration.
Existing team synthesis and research soak tests cover late reports, steering,
failed sectors and the lead's final answer reaching the persisted transcript.

These offline tests verify runtime behavior. Live model behavior is tested
separately by the matrix below. The research soak exposes 60 individual timing
seeds, including failed workers, instead of hiding repeated runs inside one test.

## Repeated live model checks

`tests/integration/chat-agents-market-live.spec.ts` reproduces the Vietnamese
stock prompt at medium/high/max with real `gpt-reserve` calls and live web
fetches. It adds an explicit Vietnam market scope and 2026-09-08 assessment
date and two workers. A test watchdog bounds elapsed time independently of auto.
It isolates app storage, denies file/shell mutations, saves reports/todos and
accepts honest unavailable-data findings. Automated checks cover report
lifecycle, not correctness of financial claims; inspect the saved final answer
and source/tool results. Run explicitly with the integration config; artifacts
are written under `.data/live-market/` (older runs used `.data/market-live/`).

### Verification on 2026-09-08

Latest persisted-market audit (these are delivery checks, not completed research):

| Effort | Delivery | Remaining limitations | Artifact directory under `.data/live-market/` |
| --- | --- | --- | --- |
| medium | Lead and two worker reports present; lifecycle checks passed, 393 s | No worker warning recorded; price accuracy still requires independent review | `2026-09-08T09-04-28.309Z` |
| high | Lead and two worker reports present; lifecycle checks passed, 524 s | One worker stopped after consecutive source errors | `2026-09-08T09-20-23.677Z` |
| max | Lead synthesized after both worker reports; lifecycle checks passed, 626 s | Both workers reported partial findings at token limits; sector todos remain pending | `2026-09-08T09-46-06.366Z` |

The max report explicitly distinguishes verified-price claims from unavailable
nonfinancial-sector prices and unverified October forecasts. This audit checked
report delivery, warnings and pending todos, not each financial claim against an
independent source. HTTP 403/404/503 responses remain unavailable sources.
The live test now records `noWorkerWarnings`, `allPublishedPlansDone` and
`priceAccuracy` separately from its asserted delivery checks. Only successful
`write_todos` results count as published plans.

Final verification of the current runtime/sample changes: 1,772 unit tests
passed, one skipped across 146 files (`--maxWorkers 4`). Core build,
workspace/backend/web typechecks and lint passed. The full-suite run first
exposed a five-second harness timeout around a 20-second npm command, causing
premature cleanup/EBUSY; that test now allows 25 seconds and the full rerun
passed. The catalogue-policy fixture now explicitly declares no authentication.
The market artifact review fields were tightened after the above live runs;
their historical artifacts retain their original check schema.

Earlier live reproduction history follows:

Live stock reproduction and additional fixes:

| Effort | Result | Duration | Artifact directory under `.data/market-live/` |
| --- | --- | --- | --- |
| medium | Passed report/lifecycle checks | 185 s | `2026-09-08T07-24-26.958Z` |
| high | Passed report/lifecycle checks | 404 s | `2026-09-08T07-24-27.026Z` |
| max, first retry | Failed: test deadline, no final lead report | 600 s | `2026-09-08T07-24-26.928Z` |
| max, after unavailable-data guidance and fetch timestamp/timeout | Passed report/lifecycle checks | 484 s | `2026-09-08T07-35-24.015Z` |

The original medium run's obsolete-self-check loop was stopped separately;
its evidence is retained above. The max deadline was not increased for the
passing rerun. Source outputs, final reports and lead todos were inspected.
Medium/high clearly distinguished unavailable dated prices; the successful max
rerun distinguished intraday snapshots, partial September observations and
October outlook. Some earlier runs exceeded the prompt's source-count guidance
or confused retrieval dates, motivating explicit reporting guidance and
`fetchedAt`. Lifecycle checks alone do not certify financial accuracy or full
instruction compliance; source limits in prompts are not enforced quotas.

The full unit suite after the runtime/web fixes passed 1,757 tests with one
skipped. Subsequent timestamp, timeout and report-instruction refinements passed
the relevant focused suites (95 sample/team tests and 26 completion/report tests).
Core build, typechecks and lint passed. A final real-model analysis/max fixture
run and persisted-transcript audit passed 1/1 under
`.data/live-matrix/2026-09-08T07-37-36.716Z/`, exercising the latest submission
report instruction. The market rerun started before that final wording change.

After introducing `maxTurns: number | 'auto'` and enabling auto for sample teams:

- Full unit suite: 1,751 passed, one skipped (144 files, `--maxWorkers 4`).
- Core build, workspace/backend/web typechecks and repository lint passed.
- Live `gpt-reserve`: research/medium, coding/high and analysis/max passed,
  one run each, using the sample's real Team-auto pipeline. Persisted-transcript
  audit passed 3/3. Each run reconciled its plan, retained worker reports and
  produced the final lead synthesis. Coding also passed the unchanged fixture
  test; analysis calculated its result without an answer supplied in the prompt.
- Artifacts: `.data/live-matrix/2026-09-08T07-00-18.666Z/`. These fixture-based
  live checks complement deterministic tests that explicitly exceed the old
  step ceilings; they do not establish unlimited task completion or market-data
  accuracy.

Additional verification after the native-tool interrupted-stream fix:

- The two new regression cases failed before the fix (search narration became
  `final-answer`) and passed afterwards. The five relevant unit files passed
  164 tests, including team synthesis and the research timing soak.
- Core build, workspace/backend/web typechecks and repository lint passed.
  Before this additional fix, the full unit suite passed 1,725 tests with one
  skipped; that full-suite result is not a post-fix full-suite run.
- Live budget finalization passed once per effort (medium/high/max) using
  `gpt-reserve`, with artifacts in `.data/live-budget/2026-09-08T06-47-53.110Z/`.
- Live Team-auto analysis at max passed after removing the expected numeric
  answer and anomaly IDs from the prompt. Persisted-transcript audit passed
  1/1; artifacts are in `.data/live-matrix/2026-09-08T06-49-27.931Z/`.
- These are fixture-based model calls. They do not validate live stock prices
  or the distinct model ID `gpt-reserver` from the reported prompt.

The additional `gpt-reserve` max-effort run in
`.data/live-matrix/2026-09-08T04-22-54.419Z/` passed all three scenarios.
The independent persisted-transcript audit also passed 3/3. Each run ended
with exactly one lead final response, two worker reports, a reconciled lead
plan, and the expected fixture evidence. These were real model calls over
synthetic documents and code, not live market research.

| Scenario | Duration | Model calls | Result |
| --- | --- | --- | --- |
| Research | 167 s | 18 | Dated evidence and forecasts distinguished |
| Coding | 178 s | 27 | Exclusive-cursor tests passed; test fixture unchanged |
| Analysis | 173 s | 23 | 340 USD, duplicate b and missing c reported |

The unit suite passed 1,686 tests with one skipped (`--maxWorkers 4`);
typechecks and lint passed. A full-concurrency run exposed a test harness
timeout: two npm commands each allowed 20 seconds were wrapped in a five-second
test, causing premature Windows cleanup and EBUSY. That test now allows 45
seconds; all 43 tests in its file passed after the adjustment.

### Matrix setup

`tests/integration/chat-agents-live-matrix.spec.ts` uses the sample's real
`runPrompt` pipeline with Codex `gpt-reserve`. It runs research, coding and data
analysis at medium/high/max, twice each (18 runs), in isolated workspaces and a
temporary app database. It requires the sample's existing Codex sign-in and
consumes real model usage. The data sources are synthetic fixtures; this tests
real model decisions against known answers, not live market-price accuracy.

```powershell
pnpm --filter @ai-agent-sdk/core build
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chat-agents-live-matrix.spec.ts
```

Artifacts go to `.data/live-matrix/<timestamp>/`: per-run events and final
answers, progress, catalogue, and a summary. Reasoning deltas are excluded.
Use `CHAT_AGENTS_LIVE_MODEL` to select a different model and
`CHAT_AGENTS_LIVE_REPEATS` (1–10) to change repetitions. Focused reruns can use
Vitest's `-t 'research.*medium'`. The original fixture checks are also audited
against persisted transcript nodes, so worker commentary cannot count as a
final report and merely publishing a todo list cannot count as reconciling it.

```powershell
node scripts/audit-chat-live-matrix.mts samples/chat-agents/.data/live-matrix/<timestamp>
```

Repeated live research uncovered a separate closure race: a worker sent its
findings via `send_message`, and the lead closed it while it was still running
its final response. The final worker report vanished even though the lead
could synthesize the message. `close_agent` now returns `closed: false` for an
unfinished worker and asks the lead to wait. Deliberate abandonment requires
`cancelRunning: true`; host `closeWorker`, disposal and user Stop still cancel
immediately. This behavior is covered by deterministic regression tests and
focused live reruns.

A second live analysis run exposed a completion loop: after an accepted
`submit_result`, the lead marked its todo list done. The SDK invalidated the
submission for every non-submission tool, including that progress-only update.
The lead then rewrote its conclusion repeatedly instead of finishing. Tools may
now declare `completionExempt: true` when they only publish progress;
`write_todos` does so. This flag is independent of `budgetExempt`: reading new
evidence, editing, delegating and asking questions still invalidate completion.
Progress updates may accompany a submission in the same batch without pretending
that a batch containing new substantive work has been verified.

To reproduce the final-todo sequence with real model decisions:

```powershell
$env:CHAT_AGENTS_LIVE_FINAL_TODO = '1'
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chat-agents-live-matrix.spec.ts -t 'analysis.*medium'
Remove-Item Env:CHAT_AGENTS_LIVE_FINAL_TODO
```

`tests/integration/team-budget-live.spec.ts` adds six live runs (two per effort)
with a worker limited to two work steps. It checks exactly one additional final
report, preservation of the numeric evidence, and delivery to the lead. A report
does not silently turn an unaccepted deep-mode self-check into confirmed success.

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/team-budget-live.spec.ts
```

Keep raw run artifacts when refining acceptance checks. Month names such as
“October 2026” and LaTeX percentages such as `20\%` must not be misclassified as
missing facts. Conversely, progress commentary is not a worker final report.

## Prompts for live reproduction

`tests/integration/chat-agents-market-live.spec.ts` runs the reported Vietnamese
stock prompt through the actual sample pipeline at medium/high/max. It uses
public `fetch_url` reads, two sector workers, isolated app data, and the explicit
reference date 2026-09-08. It requires the exact model in the account catalogue
and checks worker/lead reports, plan publication and run termination. Source and
price accuracy require inspection of the saved report; lifecycle assertions
alone do not establish accurate financial research.

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chat-agents-market-live.spec.ts
```

Artifacts are saved under `.data/live-market/<timestamp>/`. No fixture supplies
prices or expected stock picks; unavailable observations must be reported as
unverified, and October must remain a forecast. The test denies file mutations
and shell commands. It consumes real model usage and public network reads.

Use Team-auto and repeat with each effort actually offered by the configured
provider. Run coding prompts in a disposable workspace.

| Topic | Prompt | Check |
| --- | --- | --- |
| Original stock research | Tổng hợp giá và cổ phiếu có tiềm năng tháng 9–10/2026; chia nghiên cứu theo ngành. Ghi thị trường, ngày chốt dữ liệu, nguồn và giả định. | Separate observed prices from future forecasts; lead integrates all sectors and names unavailable data. |
| Energy research | So sánh công nghệ lưu trữ điện: pin lithium, sodium-ion và thủy điện tích năng. Chia agent theo công nghệ, tổng hợp chi phí và độ tin cậy của nguồn. | Conflicting dates/units and an unreachable source must be visible in the final report. |
| Coding | Tái hiện lỗi phân trang bị lặp bản ghi, sửa và kiểm thử; một agent điều tra, một agent triển khai, reviewer chạy sau khi có bản sửa. | Respect dependencies and file ownership; denied commands remain unverified, not passed. |
| Data analysis | Đối soát doanh thu hai CSV có dòng thiếu, mã trùng và đơn vị tiền khác nhau; chia agent kiểm tra dữ liệu và phương pháp tính. | State missing data and reconcile totals; do not invent values to complete a todo. |
| Steering | Trong lúc research, đổi phạm vi sang doanh nghiệp vốn hóa lớn và yêu cầu cập nhật kế hoạch. | Lead consumes the correction and the final report uses the new scope. |
| Failure/cancellation | Cho một nguồn trả lỗi hoặc worker chạm giới hạn; thử Stop trong một lượt riêng. | Partial findings reach the lead; Stop creates no additional summary call. |

For every run, inspect the last visible lead answer, worker reports, todo
states, and usage. A self-check card alone is insufficient. A partial report
must identify gaps without claiming the objective was achieved.
