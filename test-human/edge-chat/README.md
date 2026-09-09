# Edge Chat human test

This acceptance harness is a real ChatGPT-like website running in Wrangler's
`workerd`, not a Node HTTP compatibility shim. The worker source uses only Web
Standards and the Universal `core` package; the optional live companion adds
one Universal provider package. It covers multi-turn
sessions, SSE text streaming, a host-tool loop, usage accounting, active-stream cancellation,
input limits, concurrent isolated conversations, responsive UI, and browser
`localStorage` persistence.

The target deep search is a bounded run instruction, not an application-authored
workflow. The hermetic fixture only emulates that interaction: UI/API mode or
recognized phrases select a fixed host-owned overlay, and `deepSearchResponse()` branches over
history to choose search/read/audit calls and generate a report. Its topic
selection and audit oracle are hard-coded to two corpus topics. The audit tool
matches supplied URLs, without independently proving successful reads or semantic
sufficiency. This is scripted SDK/UI evidence, not evidence that a real agent
follows instructions, plans autonomously, or performs adequate Internet research.
Keep the emulation inside the test provider; do not port its scheduler or URL
oracle into the target application's agent orchestration.

The UI follows the transcript separation used by agent harnesses: adaptive
plan/progress narration is rendered separately from the live tool-call timeline,
and the final response is retained as Markdown source and rendered into safe DOM
elements. Mode, progress, tools, audit results, source links, and the final report
all survive reload.

```bash
pnpm human:edge-chat
pnpm human:edge-chat -- --headful
pnpm human:edge-chat -- --parallel 16 --run-id manual-edge
pnpm human:edge-chat -- --dry-run
pnpm human:edge-chat:live -- --dry-run
pnpm human:edge-chat:live -- --run-id manual-live-edge
pnpm human:edge-chat:live -- --run-id spark-live --model gpt-5.3-codex-spark --fallback-model gpt-5.6-luna
pnpm human:edge-chat:live -- --run-id foundry-luna --model gpt-5.6-luna --effort high --prompt-file test-human/edge-chat/live/prompts/microsoft-foundry-agent-service.vi.md --max-turns 64 --max-tool-calls 100 --max-total-tokens 1000000 --timeout-ms 1500000 --no-search-fallback
```

`human:edge-chat:live` is the separate authenticated Internet gate. It reads the
SDK's project-local Codex login from `.providers/.codex/auth.json` by default.
Set `AI_AGENT_SDK_CODEX_AUTH` or pass `--auth-file` to override it. The runner injects it into local
workerd through an ephemeral mode-`0600` environment file, and deletes that file
after the run. The browser and artifacts never receive credentials. A real agent
chooses its own searches, reads and audit timing from instructions; the host only
enforces bounds and records successful read receipts. Output includes
`report.md`, `research-evidence.json`, `review.json`, JSONL and screenshots.
`review.json` intentionally starts at `pending-independent-review`: automated
coverage/provenance checks do not certify semantic report quality.

Research exercises may be stored as UTF-8 prompt fixtures and selected with
`--prompt-file`; `--prompt` and `--prompt-file` are mutually exclusive. The
Foundry fixture contains exactly the user's one-sentence question: the detailed
benchmark rubric is host-side evaluation and is never sent to the model. It has
no prepared URLs, status labels, output outline, or expected recommendation.
The reviewer rubric lives at
`live/rubrics/microsoft-foundry-agent-service.vi.md`; it documents which checks
are automatic and which still require independent semantic review.
The reusable live instruction is task-neutral and tells
the agent to treat prompt assertions as questions rather than evidence. Runtime
budgets (`--max-turns`, `--max-tool-calls`, `--max-total-tokens`), reasoning
effort, and browser timeout are explicit so a broad benchmark is not silently
judged under the smaller default research budget.

The live command wraps the single-run acceptance with bounded search recovery.
If, and only if, the selected model completes without the required provider-native
search evidence, it repeats the same autonomous-agent acceptance with
`gpt-5.6-luna` (override with `--fallback-model`). The two runs and token reports
remain separate and a small recovery summary links them. Auth, transport, and
unrelated failures never trigger this fallback. Use `--no-search-fallback` when a
strict single-model negative result is desired.
After an interrupted runner or an already-recorded model-quality failure, pass
`--resume-primary-run <run-id>` to classify that artifact and continue only the
fallback leg instead of paying for the primary research twice.

The runner writes `summary.json`, `events.jsonl`, and desktop/mobile screenshots
below `test-human/results/edge-chat/<run-id>/`. The model adapter is deliberately
deterministic and offline, so this proves SDK/runtime behavior without a provider
credential. A production deployment should replace the in-isolate session map
with a durable Edge store such as a Durable Object; browser transcripts already
survive reloads, but server conversation state intentionally does not promise
cross-isolate durability.

The included `web_search` uses a deterministic corpus so CI remains hermetic.
Its tool contract and UI events are the same boundary a host can connect to a
real search service; `read_web_page` rejects every URL outside the search corpus
to keep the acceptance example SSRF-safe.

Both `app.ts` and `scripted-fixture.ts` are runtime-boundary checked: neither may
import `node:*` or refer to Node globals such as `process` and `Buffer`.
