# Multi-agent upgrade — diagnosis, directions, benchmark contract (2026-10-16)

Integration branch: `multiple-agent-upgrade`. Each direction lives on its own branch
`ma/<direction>` cut from this branch, is benchmarked against the integration branch, and
is merged only when it wins (or is neutral on quality and clearly cheaper).

## Goal

Multi-agent in `packages/core/src/agent/team/` must deliver real value in two shapes:

1. **Lead delegates, workers report** — lead splits work, workers solve a sub-problem end to
   end, lead receives a compact result and synthesizes.
2. **Collaborate on one problem** — members share state (task board / notes), message each
   other, claim work, and converge on one answer.

Both shapes share one lean core. Reference designs: `.temp/codex` (V1/V2 collab tools),
`.temp/openclaw` (`sessions_spawn` + announce/yield), `.temp/deepseek-harness`
(`subagent` + settlement notice, Agent Teams task board).

## Diagnosis (current state, main @ 47408a9)

- D1 No delegation strategy for the model. `LEAD_INSTRUCTIONS`
  (`managed-controls.ts:12-26`) is protocol facts only and defers strategy to the host.
- D2 Results arrive by polling. `managed-lead.ts:61-111` holds the lead turn 15 s
  (`DEFAULT_HOLD_WAIT_MS`) then re-runs the model with "Outstanding managed workers…".
  Long workers cause many wasted lead model calls.
- D3 `followup_task` description promises "wait for its accepted result"
  (`team-tools.ts:46`) but returns `accepted` immediately.
- D4 Duplicate payloads. Reports are pushed into lead history (≤8 KB) and
  `list_agents` / `wait_agents` re-return every member's full `outcome.text`.
- D5 Too many concepts (6 tools, quiet/wakeup, 5 statuses, fork/fresh, dependsOn, writes,
  slots, cancelRunning). Finished workers hold slots until `close_agent`.
- D6 No collaboration primitive: worker `send_message` is quiet (never wakes recipient),
  no shared task board / notes / claims.
- D7 Workers do not inherit the lead's tools; identity = lead + one sentence.
- D8 No evidence of value: existing benchmark is host-scripted (host calls `team.spawn`),
  synthetic tasks, no single-agent baseline.

## Directions (one branch each)

| Branch | Scope |
| --- | --- |
| `ma/benchmark` | Autonomous benchmark: single-agent vs team on realistic tasks. Prerequisite for judging all others. |
| `ma/push-join` | D2–D5: push settlement notice, yield/join instead of 15 s hold, auto-release finished slots, status-only `list_agents`, fix `followup_task`. |
| `ma/delegation-guidance` | D1, D7: delegation guidance in lead instructions + `spawn_agent` description (critical path vs sidecar, disjoint write scopes, brief contents, don't poll, don't redo), workers inherit lead tools by default, role presets. |
| `ma/collab-board` | D6: opt-in collaboration mode — shared task board (create/claim/complete, revision CAS, blockedBy), peer messages that wake the recipient with bounded turns, lead must join members before final answer. |
| `ma/lean-surface` | D5: reduce model-facing tool surface to the minimum (codex V1-like) while keeping host API compatible. |

Directions may overlap; when two win on overlapping code, merge the stronger one first and
rebase the other.

## Benchmark contract (`ma/benchmark`)

Location: `test-human/multi-agent-bench/`. Must run against any branch without edits.

- **Arms**: `single` (one agent, same tools, same model) vs `team` (managed lead +
  workers, lead decides autonomously whether/how to spawn). Optional `collab` arm when the
  branch exposes collaboration mode.
- **Tasks** (≥6, deterministic graders, fixtures in-repo, run in temp workspace copies):
  - parallelizable research/extraction over many files (benefits from fan-out),
  - multi-file code change with tests that must pass (disjoint write sets),
  - bug hunt across a small fixture repo (independent hypotheses),
  - one tightly-coupled sequential task where delegation should NOT help
    (team must not be worse),
  - one review/verification task (fresh-context reviewer),
  - one task requiring collaboration on a shared artifact.
- **Metrics per run**: pass/score from grader, total SDK tokens (input/output, all
  sessions), lead model calls, wall time, spawns, wasted lead turns (turns with no new
  information), failures/timeouts. Cost is tokens only (no USD).
- **Providers/models**: default `provider-codex` with `gpt-6-luna` (project policy minimum;
  a newer model may be selected explicitly). Never fall back to older models; report
  errors. ZenMux free model `dots-studio/dots3-note-prev` optional second provider.
- **Protocol**: N≥3 repetitions per (arm, task); report mean/median and pass rate; JSON
  results under `docs/evaluations/multi-agent-upgrade-2026-10/<branch>/`; `analyze` script
  prints a comparison table between two result sets.
- **Offline mode**: scripted/fake adapter mode that exercises the harness end to end in CI
  without live calls.

## Merge gate

A direction merges into `multiple-agent-upgrade` when:

1. `pnpm typecheck`, `pnpm lint`, unit tests for `packages/core` pass.
2. Benchmark (live, N≥3) vs integration branch: team-arm quality ≥ baseline and at least one
   of — quality up, tokens down ≥15 %, lead calls down ≥30 %, wall time down ≥20 % — with no
   task regressing by more than one run.
3. Claude review finds no blocking correctness issues.
