# A2A website MVP stress harnesses

These provider-backed human tests use both A2A orchestration modes to build an
actual multi-feature website. The artifact is **LaunchPad Ops**, a responsive
SaaS launch command center with a delivery board, forecast lab, and decision
center. It uses browser-native ES modules and has no install step.

## Managed dynamic mode

```powershell
npm run human:a2a-managed
```

The coordinator dynamically creates `delivery`, `analytics`, and
`collaboration` product engineers in one parallel `spawn_agent` batch. Each
worker owns a separate feature source, unit test, and handoff document. The
coordinator receives their results, integrates the shell and visual design, and
builds the website.

## Pre-defined composed mode

```powershell
npm run human:a2a-defined
```

The same three specialists exist before execution. The coordinator delegates
with `followup_task`, synchronizes through `wait_agents`, and requires an
attributed `send_message` code handoff from each specialist before integration.

## Website produced

A successful workspace contains:

```text
index.html
src/
  app.js
  styles.css
  core/{contracts,data,store}.js
  features/{delivery,analytics,collaboration}.js
tests/{delivery,analytics,collaboration}.test.mjs
docs/{delivery,analytics,collaboration,mvp-report}.md
dist/                         # built website
```

From a successful workspace, run `npm run preview` and open the printed local
URL to use the generated MVP.

The MVP must support:

- searching/filtering/adding/advancing launch work items;
- persisted state and activity history;
- readiness, blocker, effort, budget, and forecast calculations;
- adjustable capacity/risk assumptions and an SVG visualization;
- decision capture, activity filtering, and JSON snapshot export;
- a responsive, accessible, visually coherent integrated dashboard.

## Why A2A is required

The three vertical slices have exclusive file ownership and are deliberately
independent, so they can be implemented and unit-tested concurrently. The
coordinator works only after those parallel slices return and owns integration.
This models the actual MVP acceleration pattern instead of generating three
analysis reports.

Every specialist must call `list_files`, `grep_files`, `read_file`,
`write_file`, and `run_command`; cross automatic compaction while reading its
large product-discovery corpus; continue coding afterward; and run its own
Node test through `npm test -- <file>`. The coordinator must run the complete
`npm test` and `npm run build` gates.

Those strings are the model-facing interface, not arbitrary package execution.
The host maps only the exact expected argv shapes to fixed `node` entrypoints
under the Node permission model. Each identity can write only its three owned
paths; test processes have read-only workspace access and no network, child
process, worker, addon, or inherited provider-secret environment. The seeded
build process can write only `dist/`. Host-owned scripts, core contracts,
product inputs, and pressure corpora are SHA-256 checked after the run. This is
a hardened acceptance boundary, not a claim that the general `agentcode`
`run_command` tool is a container sandbox.

The host then independently reruns both gates. The command exits nonzero unless
the runtime event log proves real sub-agent execution/compaction/handoff and the
workspace contains substantial feature code, tests, responsive styling, an
integrated app, and a built `dist/` artifact.

Artifacts are retained under:

- `test-human/workspaces/a2a-stress/<run-id>-<mode>` — runnable website source
  and `dist/`;
- `test-human/results/a2a-stress/<run-id>-<mode>` — prompt, config, provider
  logs, agent/tool events, team messages, and `verification.json`.

Useful options:

```powershell
# Inspect the fixed build prompt without provider I/O or workspace writes
npm run human:a2a-managed -- --dry-run
npm run human:a2a-defined -- --dry-run

# More aggressive compaction
npm run human:a2a-managed -- --max-input-tokens 3000

# Stable artifact path
npm run human:a2a-defined -- --run-id launchpad-acceptance-01

# Opt in to exact per-run provider request logs (prompts may be sensitive)
npm run human:a2a-managed -- --logs
```

Defaults use Codex `gpt-5.6-luna`, medium effort, 18 model turns and 64 tool
calls per agent, a 3,500-token compaction threshold, and a 20-minute whole-run
timeout. A live run makes multiple provider calls and intentionally exercises
several independent compaction cycles.
