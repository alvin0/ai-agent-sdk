# Autonomous multi-agent benchmark

The host supplies a task, identical workspace tools, and an isolated temporary workspace. Models
choose whether/how to delegate through the built SDK's native managed-team tools. Production SDK
hooks, prompts and APIs are unchanged. Fake runs exercise the protocol; they are not quality evidence.

Requires Node >=24.9 and locally built packages. Paths to SDK bundles, fixtures, worker scripts and
Git metadata resolve from `import.meta.url`, so the CLI can run from any directory against this worktree.

```sh
pnpm install --frozen-lockfile # only if node_modules is missing
pnpm workspace:build
node /absolute/worktree/test-human/multi-agent-bench/run.ts \
  --provider codex --model gpt-6-luna --codex-auth /absolute/path/auth.json \
  --suite scaled --seed 16102026 --arms single,team --reps 3 --label candidate \
  --max-total-tokens 400000 --max-turns 240 --max-tool-calls 320 \
  --out /tmp/ma-candidate
```

`--codex-auth` selects an explicit **revisioned CAS** `fileCodexCredentialStore` from auth-node,
passed to provider-codex's adapter. Alternatively set `AI_AGENT_SDK_CODEX_AUTH=<absolute file>`.
The flag takes precedence over the environment. Relative explicit paths resolve from the launch
cwd; the default `.providers/.codex/auth.json` resolves from this script's repository root.
Credentials never enter task workspaces or result files (the selected path is recorded).
The default live model is `gpt-6-luna`; a newer generation/tier must be explicitly selected.
Older models fail validation and there is no fallback. Optional ZenMux support is not implemented.

```sh
# Round 3 offline protocol validation: six scaled tasks, two arms, one repetition = 12 runs.
node test-human/multi-agent-bench/run.ts --provider fake --suite scaled \
  --arms single,team --reps 1 --concurrency 2 --label offline-round3 --out /tmp/ma-offline-round3

# Preserve the original six small fixtures for quick smoke checks.
node test-human/multi-agent-bench/run.ts --provider fake --suite smoke \
  --arms single,team --reps 1 --out /tmp/ma-smoke

# Inspect generated fixtures independently; output directory must be new.
node test-human/multi-agent-bench/generate-fixtures.ts 16102026 /tmp/ma-generated
pnpm exec vitest run tests/unit/multi-agent-bench.spec.ts
```

Defaults: `--suite scaled`, seed `16102026`, three repetitions, one independent process at a time,
180000 ms wall deadline, four workers maximum, medium effort, 400000 total tokens, 240 model
requests and 320 tool dispatches **per run, shared across every session**. The same aggregate limits
apply to single, team and collab. `--label` is saved in the manifest; it does not affect comparability.
Task/rep pairs alternate arm order. Use matching settings and seeds on both branches.

Token usage is summed once per SDK `sdk.model.call` end across lead and workers. On reaching the
aggregate cap, a shared signal aborts execution and stops admission to further requests/tools.
Already running calls can overshoot because usage arrives at settlement; this is an observed usage
cap, not a provider reservation guarantee. Missing usage stays unknown. Model/tool checkpoint
admission enforces aggregate turn/tool limits even on SDK coordination tools exempt from session
budgets. `metrics.capHits.{tokens,turns,toolCalls}` records which caps bound a run, and `status: cap-hit`
is separate from timeout/failure. Cap hits count as unsuccessful runs even if an artifact already exists.
Per-session step ceilings are above the shared admission ceilings, so they do not silently take over.

Output directories must be new. A nonzero CLI exit indicates an SDK, cap, timeout or infrastructure
failure; an incorrect artifact from a completed agent remains a completed, failed grade.
`--arms collab` is supported explicitly and records a skipped arm when unavailable. Detection uses
public exports: `MANAGED_TEAM_FEATURES.collaboration === true` plus `createManagedAgentTeam` maps to
`{ collaboration: true }`. Legacy class/factory/mode detection also remains supported. Requested arms
are respected; detection does not add an unrequested arm. This branch does not expose collaboration.

## Tasks

`generate.ts` uses a seeded xorshift PRNG. Large data is generated at workspace creation; only the
small smoke fixtures and generator code are committed. Graders, expected answers and repairs stay
outside model-visible workspaces. Every run receives the same seed, regardless of arm/repetition.

| ID | Default scaled task | Checks |
| --- | --- | --- |
| extraction | 24 CSV logs, each ~14–16 KB (one 16 KiB page), four services per file | Exact per-file nearest-rank p95 by service, error-code histograms including OK, global count/histogram |
| code-change | Eight spec sections/modules with disjoint write sets and a frozen shared interface | 40 hidden executable edge cases plus interface integrity |
| bug-hunt | 30 source files, four planted bugs in cache/ranges/billing/routing | 20 hidden checks plus healthy-module integrity; `shell test <module>` supported |
| sequential | Original ordered modular transition negative control | Complete trace and final value |
| review | 12 handlers, five violations across active-admin/exact-origin/bounded-count | Execute each proposed input against ORIGINAL sandboxed code, confirm policy rejection, reject extras, preserve source |
| shared-artifact | Eight fragments with conflicting owners and dependencies, including stale cycles | Exact authoritative reconciliation and deterministic topological order |

The review grader treats null, primitives, malformed findings and rejected counterexamples as failed
checks. Editing the submitted source cannot validate an invented counterexample: execution uses
host-held originals. A valid policy predicate alone cannot pass a finding.

## Workspace tools and sandbox

Every session gets identical `read_file`, `write_file`, `list_files`, `search_files`, and `shell`.
Team/collab sessions additionally get the SDK's coordination surface. Absolute paths, traversal,
symlinks and writes to frozen paths (including normalized aliases) are rejected.

- `read_file({path,offset?,limit?})`: at most **16 KiB** per call, byte offset defaults to zero.
  Returns `{content,nextOffset,totalBytes}`; continue until `nextOffset` is null. UTF-8 boundaries
  are preserved. `limit` cannot exceed 16384.
- `write_file`: up to 64 KiB, at most 128 workspace files. Creates parent directories.
- `search_files`: literal matching, capped at 40 lines and 16 KiB; cannot produce numeric aggregates.
- `shell` on **extraction** (scaled and smoke, all arms): only `test` is offered and accepted.
  There are no executable checks for extraction; its final artifacts are graded by the host.
  Exact per-file p95/histograms require reading and deriving facts; search cannot compute them.
- `shell` on **other tasks**: `test` runs all hidden checks; `test <module>` selects one module's checks.
  `run <script.cjs> <output.json>` runs an authored script whose `module.exports.run()` returns JSON,
  then writes that JSON artifact. Inside it, `list_files()` and `read_file(path,offset)` expose only
  workspace snapshots with the same 16 KiB paging; no model-visible full-file read shortcut.
  Scripting stays available where natural for code, review, reconciliation and sequential tasks.

Execution occurs in a separate Node process with an empty environment and no filesystem, child,
addon or worker permissions. A VM disables dynamic string/Wasm code generation; only serialized
workspace data crosses the boundary, never host callbacks or credentials. Evaluations have bounded
timeouts and a 3-second process kill guard. Script output is bounded at 64 KiB. This is a narrow
fixture runner, not a container for arbitrary repositories. Parent-owned temp roots are cleaned
up even if a run process is killed.

The fake adapter discovers spawn/wait tools by offered names/descriptions and fills required schema
fields only. It reads the returned worker address instead of assuming a name. Its fixed repairs,
findings and 100 input/20 output usage are synthetic protocol data. Scaled extraction reads all 24
CSV pages through the SDK and emits a separately calculated, host-scripted answer to cross-check
the generator/grader. This scripted adapter behavior is not a live-model capability measurement.

## Results and comparison

Each `*.json` contains grades, final text, metrics and a workspace snapshot. `*.audit.json` retains
SDK observations, model-request evidence fingerprints and dispatches. Fatal process errors get
`*.fatal.json` with unknown metrics and failed grades. `manifest.json` records model/provider,
label, suite, seed, all limits, commit/dirty state, Node version, fixture/harness/core-bundle hashes,
skipped arms, resolved `perTaskLimits`, and the `autonomous-v3` protocol. V1/V2 results require rerunning.
The effective limits are also present in every result/job. Task definitions may set `limits` in
`tasks.ts`; explicit CLI caps override task values, which override the shared defaults.
Harness hashes contain only relative bench paths and bytes; SDK bundle hashes are recorded separately.
Keep output directories outside `test-human/multi-agent-bench/` so results do not enter its hash.

Tokens sum the SDK's disjoint input/output/cache-read/cache-write buckets; reasoning is already
in output. Incomplete usage yields `totalTokens: null`, with `reportedTokens` preserving partial
usage. `leadModelCalls`/`totalModelCalls` count SDK logical starts. `spawns` counts actual attachment
events. `toolCalls` counts admitted dispatches, including coordination calls. `wallMs` includes
execution, quiescence and disposal; it excludes fixture generation, grading and serialization.

`wastedLeadTurns` counts lead requests with no newly observed non-assistant evidence. Worker text
and JSON settlement reports from `producer: managed-team` or `managed-team-settlement` count. Pure recognized hold/status
notices (including lean `Read their results with wait_agents.` and the managed-team
`All workers settled — synthesize now.` control wake) and status-only wait/list/join results do not.
Settlement-producer messages remain evidence even when their text resembles a control wake. New non-status tool results count. Identity
fields and repeated semantic contents are deduplicated; losing history entries does not create
new evidence. Unknown notice formats conservatively count as evidence. This is an operational
proxy, not a judgment about private reasoning. Error events may be reported at multiple layers.

```sh
node test-human/multi-agent-bench/analyze.ts /tmp/ma-baseline /tmp/ma-candidate
```

The table shows per-task/per-arm and `ALL` distributions/pass rates, and **B versus A delta %**
for mean score, tokens, lead calls, wall and wasted turns. Positive means an increase; lower cost
is better. Zero-to-zero is 0%; nonzero from a zero baseline or unknown usage is `n/a`. JSON is
written to `<dirB>/comparison.json` and includes mean/median statistics, cap hits, errors, timeouts,
labels and configuration/sample mismatch warnings. Aggregates weight runs equally.

The merge gate still needs matched **live N>=3** runs, quality at least baseline, plus quality up,
tokens down >=15%, lead calls down >=30%, or wall down >=20%, and no task regressing by more than
one run. The sequential control should stay at parity. Offline results establish no performance win.

## Copy into another worktree

Use exactly the same bench bytes on every SDK revision. This replaces only the destination bench
folder; it does not change the destination SDK or Git branch. The source worktree must have built
packages before launching the comparison driver.

```sh
src=/absolute/path/to/benchmark-worktree
dst=/absolute/path/to/candidate-worktree
mkdir -p "$dst/test-human/multi-agent-bench"
rsync -a --delete "$src/test-human/multi-agent-bench/" "$dst/test-human/multi-agent-bench/"
(cd "$dst" && { test -d node_modules || pnpm install --frozen-lockfile; } && pnpm workspace:build)
# May be launched from any cwd; imports, fixtures, Git and hashes belong to dst.
node "$dst/test-human/multi-agent-bench/run.ts" \
  --provider codex --model gpt-6-luna --codex-auth /absolute/path/auth.json \
  --suite scaled --arms single,team --reps 3 --concurrency 1 --label candidate \
  --out /tmp/ma-candidate-round3
```

For multiple branches, the driver takes repeated `--worktree <label> <directory>` arguments; the
first is baseline. It freezes one harness snapshot, replaces each explicitly listed bench folder,
installs only when needed, builds each worktree, verifies equal bench hashes, runs each suite,
and analyzes every set versus the first (including a baseline self-check). SDKs run sequentially;
`--concurrency` controls independent jobs inside each suite. Existing output directories are rejected.
Suite failures still reach analysis and cause a nonzero exit; install/build failures stop immediately.
Only bench folders and generated build/dependency/results files change; no Git operation is performed.

```sh
node "$src/test-human/multi-agent-bench/compare-branches.ts" \
  --worktree baseline /absolute/path/to/integration-worktree \
  --worktree candidate /absolute/path/to/candidate-worktree \
  --provider codex --model gpt-6-luna --codex-auth /absolute/path/auth.json \
  --suite scaled --arms single,team --reps 3 --concurrency 1 \
  --out /tmp/ma-round3-comparison
```

Instead of `--codex-auth`, export `AI_AGENT_SDK_CODEX_AUTH=/absolute/path/auth.json`. The driver
requires one of those two explicit credential selectors for live runs and passes the selected path
through; it never logs in or supplies credential contents. Use `--provider fake --reps 1` for an
offline rehearsal. All normal run options (including seed, selected tasks, caps and timeouts) pass
through unchanged. Add `collab` to `--arms` when comparing collaboration branches; unsupported
worktrees record it as skipped, so compare that arm only where both branches support it.
