# Skill stress human harness

This harness exercises filesystem skill discovery through the same AgentSession,
tool registry, compaction, memory, and trace paths used by the SDK. Every case has
an isolated workspace and report directory, so several cases can run concurrently
without sharing history or files.

## Deterministic offline run

No provider credentials or downloaded skills are required:

```powershell
npm run human:skill-stress -- run --suite offline --parallel 4 --repeat 3 --seed 20260831
```

The offline suite uses standard `SKILL.md` folders containing unique body and
resource probes. A scripted model still passes through the real registry and tool
loop. It asserts that discovery reads only a bounded frontmatter prefix, the first
request contains catalog metadata but no body, only `load_skill` exposes the
selected body, and only `read_skill_resource` exposes the selected resource. It
also performs real workspace write/read calls, applies steering at a safe boundary,
continues a second turn, cancels a running host tool and reuses the session, and
forces a context compaction with a correlated trace span.

Two focused cases cover the SDK's two intended consumer shapes:

```powershell
# Harness: one explicit folder, automatic rediscovery between conversation rounds
npm run human:skill-stress -- run --suite offline --scenario harness-folder-rounds

# Web/workflow: session supplies a tenant provider; agent definition permits exact ids
npm run human:skill-stress -- run --suite offline --scenario defined-agent-web-skills
```

`harness-folder-rounds` adds a second `SKILL.md` folder between two turns and
proves that its metadata appears automatically while its body stays absent until
`load_skill`. It also proves that the first loaded body remains available in the
same conversation. `defined-agent-web-skills` uses no filesystem skill source:
the host supplies a lazy tenant provider, the agent declares `skillIds`, an
unrelated turn performs no activation, and an out-of-scope candidate never
reaches provider `load()`.

For a more visual acceptance test, run:

```powershell
npm run human:skill-showcase
```

That command pulls a pinned, hash-verified `frontend-design` skill from Anthropic's
skills.sh entry and gives it to a live model through the same real SDK session,
progressive skill tools, and confined workspace tools. It proves the upstream body
reached model context before the first file write, runs the generated test suite,
and leaves the runnable artifact on disk.

Inspect configuration and selected cases without creating files:

```powershell
npm run human:skill-stress -- run --suite offline --dry-run
```

## Prepared skills.sh corpus and live provider

The companion prepare command stores reviewed skills under
`test-human/skill-stress/.cache/skills` by default. A different direct skill root
can be supplied with `--skills-root`.

```powershell
npm run human:skill-stress:prepare
```

Preparation uses the pinned skills.sh CLI, disables its telemetry, installs with
copy semantics, verifies hashes, and never runs downloaded skill scripts.

The reviewed corpus is locked in `skill-sources.lock.json` with upstream
revision, file count, and whole-tree SHA-256:

- [Vercel React Best Practices](https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices)
- [Playwright Skill](https://skills.sh/testdino-hq/playwright-skill/playwright-skill)
- [Systematic Debugging](https://skills.sh/obra/superpowers/systematic-debugging)

First run the prepared corpus through the deterministic adapter. This performs no
provider request and asserts that all three pinned IDs are discovered, only
`systematic-debugging` is activated, and only `root-cause-tracing.md` is read:

```powershell
npm run human:skill-stress -- run --suite registry --parallel 3 --repeat 2
```

```powershell
npm run human:skill-stress -- run `
  --suite live `
  --provider codex `
  --model gpt-5.6-luna `
  --effort medium `
  --skills-root test-human/skill-stress/.cache/skills `
  --parallel 2
```

The live case prefers the prepared `systematic-debugging` skill, explicitly asks
the model to load it, runs a deliberately red npm test, fixes the defect, observes
a green test, writes and reads a marker file with the sandboxed AgentCode tools,
and passes the deep-mode completion gate. Downloaded skill scripts are never
executed by this harness.

## Reports and reproducibility

Results are written beneath:

```text
test-human/results/skill-stress/<run-id>/
├── summary.json
└── <case-id>/
    ├── events.jsonl
    ├── requests.json
    ├── skill-io.json
    ├── trace.json
    └── result.json
```

`skill-io.json` records discovery, activation, and resource reads separately.
Event payloads are bounded before writing; request observations store sizes and
probe presence rather than complete provider prompts. Failed workspaces are kept
for debugging. Add `--keep-workspaces` to retain successful ones as well.

Useful options:

```powershell
npm run human:skill-stress -- run --scenario progressive-tool-loop --keep-workspaces
npm run human:skill-stress -- run --suite all --parallel 2 --fail-fast
npm run human:skill-stress -- run --suite offline --verbose-events --timeout-ms 120000
```

Provider wire logging remains opt-in with `--logs`. Its daily JSONL files are
written beneath each case report's `providers/` directory, so parallel live cases
cannot mix request logs. Event, request-shape, I/O, and trace reports are always
isolated under the stress result directory.
