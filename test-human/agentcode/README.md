# AgentCode human acceptance test

`agentcode` runs one real, long coding task through the SDK. It deliberately
combines host tools, durable task memory, provider request logs, reasoning
summaries, trace/tool events, and automatic context compaction.

The process stays open after each task. Type another request to continue using
the same history, memory, workspace, and provider session. While a task is still
running, type a line and press Enter; it is queued as steering and applied at the
next safe model-step boundary without interrupting an executing tool.

```powershell
npm run human:agentcode
```

The default task builds a React Todo app with Zustand and localStorage under
`test-human/workspaces/agentcode`. To use a clean external scratch directory or
override the prompt:

```powershell
npm run human:agentcode -- --workdir C:\scratch\todo-zustand
npm run human:agentcode -- --prompt "Build another long coding task"
```

Validate configuration without creating the workspace or contacting a provider:

```powershell
npm run human:agentcode -- --dry-run
```

The CLI discovers project skills from `.agents/skills` and `.dsh/skills`,
starting at `--workdir` and walking up to its Git root. Put each skill in its own
folder with a `SKILL.md`; the CLI prints `agentcode/skills` before the first turn.
That line is phase-one metadata discovery only: it does not read any `SKILL.md`
body or resource content. The same shallow discovery is repeated before each
turn. User-home skills are intentionally disabled for this hermetic acceptance
test.

To exercise AgentCode with the reviewed skills.sh corpus from the stress suite,
prepare it once and pass its root explicitly:

```powershell
npm run human:skill-stress:prepare
npm run human:agentcode -- `
  --skills-root test-human/skill-stress/.cache/skills `
  --prompt "Build and verify a production React application; diagnose failures systematically and add browser-level tests."
```

`--skills-root` is repeatable. Prepared roots are added alongside project
discovery rather than replacing `.agents/skills` or `.dsh/skills`; earlier
prepared roots win duplicate IDs within that prepared corpus. A duplicate skill
ID between the project catalog and a prepared corpus is rejected so that the
agent cannot silently run a different workflow. Skill bodies and resources keep
the same progressive-disclosure behavior: metadata is discovered first,
`load_skill` activates one selected body, and resource tools can only read files
from an activated skill.

For CI or the original one-shot behavior:

```powershell
npm run human:agentcode -- --once
```

Interactive commands: `/memory`, `/history`, `/stats`, `/compact`, `/new`,
`/abort`, `/quit`. `/new` resets conversation memory/history but preserves the
workspace files.

The default absolute compaction threshold is intentionally low enough to make a
long build exercise checkpointing. Raise it with `--max-input-tokens`, or change
the recent verbatim tail with `--retain-tokens`. Use `--max-tool-calls` to test a
different per-turn host-tool budget. `/stats` reports completed and failed
compactions, pressure backoffs, and estimated token savings.

Pressure maintenance now pauses when the retained context makes the configured
threshold unreachable or a checkpoint produces negligible savings. This keeps an
intentionally aggressive stress threshold from compacting before nearly every
tool step.

Security boundary: direct file and search tools reject paths, symlinks, and
junctions that escape the selected workspace. This is not a sandbox for executed
code. `run_command` accepts only `npm` plus an argv array and launches npm without
a host shell, but npm package scripts and lifecycle hooks are executable code and
can access anything allowed to this OS user. Use a disposable workspace and only
providers/prompts and package dependencies you trust. Put the whole CLI in an OS
sandbox or container when filesystem isolation is required.

Searches skip dependency/build directories, lock files, minified files, and files
larger than 1 MiB by default. Read and grep have separate context caps; stdout and
stderr share one command-output budget that retains a bounded head and tail.
Large reads are streamed and return an exact line/column continuation cursor.
Recursive listing canonicalizes linked directories, detects cycles, observes
cancellation, and reports whether its file or directory traversal budget stopped
the result.
Timeout and cancellation terminate the spawned process tree before the tool
settles. On Windows, a naturally exited command also performs a bounded process
baseline snapshot for long-lived dev/e2e-like npm scripts, observes their live
ancestry, and can clean a detached descendant whose parent already exited.
Ordinary test/build/install commands do not enable CIM polling. Cleanup
revalidates both PID and process creation time immediately before termination,
has a cancellable deadline, and caps termination roots. A concurrent process is
ignored even when it uses the exact same workspace; if lineage tracking or
revalidation is unavailable, cleanup fails closed and emits a diagnostic without
changing the command result. Terminal rendering prints concise metadata instead
of duplicating
the complete model-facing tool payload. Closing stdin lets an active turn finish;
use `/abort`, `/quit`, or Ctrl+C for explicit cancellation.
