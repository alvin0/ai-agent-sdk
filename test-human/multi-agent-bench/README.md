# Autonomous multi-agent benchmark

The host supplies a task, shared tools, an isolated fixture copy, and limits. The lead chooses
whether/how to delegate through the branch's own managed team tools. The host never calls
`spawn`, assigns subtasks, forces a reviewer, or synthesizes an answer. No SDK APIs change.

Requires Node >=24.9 (TypeScript stripping and permission support), pnpm, and locally built packages:

```sh
pnpm install --frozen-lockfile # only if dependencies are absent
pnpm workspace:build
node --experimental-strip-types test-human/multi-agent-bench/run.ts \
  --arms single,team --tasks all --reps 3 --provider codex --model gpt-6-luna \
  --out docs/evaluations/multi-agent-upgrade-2026-10/my-branch/
```

The Codex Node wrapper uses `packages/provider-codex` with the same local authentication store
as `test-human/multi-agent/live-worker.ts`. Set `AI_AGENT_SDK_CODEX_AUTH` to an existing SDK
Codex auth file if needed (see `packages/auth-node` docs). No credentials are copied into fixtures.
The default model is `gpt-6-luna`; `--model` accepts explicitly selected newer generations/tiers.
Older models and unsupported providers fail validation; there is no model fallback. ZenMux is not
implemented. `fake` is the only other provider and emits clearly marked synthetic usage.

```sh
# Bounded four-run live smoke, not merge-gate evidence
node --experimental-strip-types test-human/multi-agent-bench/run.ts \
  --tasks sequential,code-change --reps 1 --arms single,team --provider codex \
  --model gpt-6-luna --out docs/evaluations/multi-agent-upgrade-2026-10/baseline-smoke/

# Full offline protocol exercise, no auth or network
node --experimental-strip-types test-human/multi-agent-bench/run.ts \
  --provider fake --tasks all --arms single,team --reps 3 --concurrency 3 --out /tmp/ma-offline/
pnpm exec vitest run tests/unit/multi-agent-bench.spec.ts
```

`--concurrency` defaults to 1; it bounds independent run processes, not worker concurrency within
one team. `--timeout-ms` defaults to 180000 per run; a parent kill guard allows 15 seconds for
SDK cancellation/disposal. All arms use the same medium reasoning effort, 40 model steps and 80
tool calls per session, 80000 SDK tokens per session, and a shared wall deadline. Teams may have
four workers; these are per-session ceilings, **not** a claim of equal aggregate token budgets.
The benchmark measures that extra cost. Task/rep pairs run in alternating arm order to reduce
ordering bias. Use the same concurrency/settings on both branches.

Output directories must be new. Parent directories are created. Nonzero exit means an SDK or
infrastructure failure occurred; an incorrect graded answer remains a recorded completed run.
Explicit `--arms collab` is skipped if unavailable. A detected collaboration arm is automatically
added. Detection checks public exports `createCollaborativeAgentTeam`, `createCollaborationAgentTeam`,
or `MANAGED_AGENT_TEAM_MODES` containing `collaboration` (managed factory receives that `mode`).
These factories must implement the managed-team host contract. Extend `collaborationFactory` for
any differently named public capability; no branch names or version strings control detection.
This branch exports none, so it records collaboration as unavailable.

## Tasks and grading

| ID | Work | Deterministic checks |
| --- | --- | --- |
| extraction | Extract 24 service records from six regional files | Exact totals and sorted complete IDs |
| code-change | Implement independent name/price modules | Four executable examples including empty/zero cases |
| bug-hunt | Diagnose TTL units and expiration boundary across a small repo | Before expiry, exact expiry, missing key |
| sequential | Ordered modular state transition, negative control | Every intermediate value and final value |
| review | Verify auth/redirect code against policy | Two valid counterexamples, no extra findings, original code intact |
| shared-artifact | Reconcile three teams' migration fragments | Dependency/owner unions and deterministic topological order |

Each run gets a fresh copy of the in-repo fixtures (under 300 KB total). Graders and expected
answers stay in the harness outside the writable copy. The sequential task deliberately has
little independent work: unnecessary delegation should show extra tokens/time. Shared-artifact
work can be solved alone or with peers; collaboration is available, never forced.
Score is the fraction of independent checks passing. Pass requires every check plus a completed
lead run. A recovered tool error can still pass; error events remain in the metrics.

Both arms and every worker receive identical `read_file`, `write_file`, `list_files`,
`search_files`, and `shell` tools. Team members additionally receive the SDK's coordination tools.
File tools reject absolute paths, traversal, symlinks, files above 64 KiB, and more than 64 files.
`shell` accepts only the literal command `test`: it executes the task's standalone CommonJS modules
and host-owned assertions in a separate Node process. No arbitrary OS commands, package installs,
imports, credentials, network APIs, or host functions are exposed to fixture code. The subprocess
has an empty environment and Node permissions with no filesystem/child/addon/worker grants; its
VM disables dynamic string/Wasm generation, with 500 ms evaluations and a 3-second kill limit.
This deliberately narrow test sandbox supports these fixtures, not general untrusted repositories.
Parent-owned temporary roots are removed even when a run child is killed.

## Metrics

Every session uses SDK observation and checkpoint hooks, including automatically resumed lead
runs and model-created workers. `*.audit.json` preserves those events, tool names, evidence
fingerprints, and terminal errors. `*.json` stores the result, checks, final text, and artifact
snapshot before cleanup. `manifest.json` records commit/dirty status, model/settings, Node version,
fixture/harness/core-bundle SHA-256 hashes, skipped arms, and synthetic/smoke flags.

- `inputTokens`: SDK uncached input summed over all logical calls, all sessions.
- `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`: SDK disjoint buckets, summed once per
  `sdk.model.call` end. Provider retries are already included by SDK call accounting.
- `totalTokens`: sum of those four buckets; reasoning is part of output, never added again.
  Any incomplete/missing usage or unfinished call makes authoritative totals `null`. `reportedTokens`
  retains the observed partial sum and `usageComplete` identifies completeness. No USD estimates.
- `leadModelCalls`, `totalModelCalls`: `sdk.model.call` starts for the lead/all sessions.
- `spawns`: worker `member-attached` events, not planned or guessed delegation counts.
- `wastedLeadTurns`: lead model requests whose evidence fingerprint equals the preceding lead
  request. The fingerprint deduplicates non-assistant message contents, removes identity fields,
  and excludes `managed-team` application hold notices. This operational proxy detects empty
  polling/continuation requests; it does not claim to classify private reasoning or all semantic
  redundancy. Units are model requests, including requests inside one SDK turn.
- `wallMs`: from workspace-ready execution start through team quiescence and disposal; excludes
  process startup, fixture copying, artifact grading and output serialization.
- `errors`: observed model/tool error or abort terminal events plus terminal/host failures (a
  failure may appear at more than one layer); `status` separates completed, failed and timeout.
  Hard child failures are `*.fatal.json` with unknown metrics, never invented zero usage.

Fake usage (100 input + 20 output per call) is adapter-scripted test data. It proves accounting
and autonomous tool dispatch work end to end; it provides no model quality or performance evidence.

## Comparing branches

Build each branch locally, place this exact harness/fixtures on each branch, and run the same
command with a distinct output label. Do not mix provider/model/settings, dirty SDK builds, fixture
versions, or fake/live runs. Then:

```sh
node --experimental-strip-types test-human/multi-agent-bench/analyze.ts \
  docs/evaluations/multi-agent-upgrade-2026-10/integration/ \
  docs/evaluations/multi-agent-upgrade-2026-10/candidate/
```

The table compares each task/arm and the aggregate, with N, pass rates, mean score, token
mean/median, lead calls and wall time. JSON printed to stdout and written to `<dirB>/comparison.json`
adds mean/median total calls, spawns, wasted lead requests, errors and timeouts. Fatal runs count
as failures in pass rates and make affected cost statistics unknown. Configuration/sample mismatches
warn and mark the comparison unsuitable for paired conclusions. Aggregates weight runs equally;
use identical task sets and repetitions. Retain per-task results to spot regressions.

A direction needs **live N>=3** versus integration, team quality at least baseline, and one of:
quality up, tokens down >=15%, lead calls down >=30%, or wall time down >=20%, with no task
regressing by more than one run. Builds, typecheck/lint/unit gates and the plan's review gate also
apply. A one-repetition smoke or synthetic run cannot establish that gate. The benchmark itself
makes no claim that delegation helps: successful guidance/coordination should reduce wasted lead
requests and improve fan-out tasks while keeping the sequential control at parity.
