# Human test harness

This folder runs the SDK against real providers and renders the same events a GUI
would consume: streamed commentary, provider reasoning summaries, host tool calls,
native tool ids, citations, progressive images, final images, trace outcomes, and
blocking human questions.

The implementation is intentionally split by control boundary:

- `cli.ts` owns argument errors, REPL commands, session lifetime, and cancellation.
- `agent.ts` declares the reusable agent with `defineAgent()`.
- `providers.ts` selects and registers the real provider adapter.
- `scenarios.ts` owns native tool choice and user-message construction.
- `terminal.ts` renders events and resolves blocking HIL questions.
- `media.ts` loads image input and saves generated image output.
- `tools.ts` contains the bounded, read-only host tools.
- `config.ts` is the pure CLI parser and defaults.
- `agentcode/` is the isolated long-running coding test with writable tools,
  durable objective memory, and an intentionally reachable compaction threshold.
- `a2a-stress/` contains two live multi-agent MVP factories: managed dynamic
  spawning and pre-defined composed collaboration. Both build a multi-feature
  website and verify worker tool use, compaction, code handoff, integration,
  unit tests, and the final `dist/` artifact.
- `skill-stress/` combines progressive skill loading, tool-loop execution,
  compaction, memory, trace assertions, and bounded parallel case scheduling.
- `skill-showcase/` pulls a pinned external skill from skills.sh and asks a live
  model to turn it into a visible website with host-owned causal checks.
- `mcp/` verifies the MCP bridge locally; `github-mcp/` connects the same client
  and tool pipeline to GitHub's official remote MCP server.

## Quick commands

```powershell
# Interactive chat; defaults to Codex gpt-5.6-luna, effort medium
pnpm human

# One real basic-mode turn
pnpm human:basic -- --prompt "Use calculate to multiply 19 by 23"

# Deep completion gate
pnpm human:deep -- --prompt "Inspect package.json and summarize its scripts"

# Let the model pause and ask you a question in the terminal
pnpm human:hil -- --prompt "Help me choose an API design; ask before selecting a trade-off"

# Provider-native web search, forced for a deterministic acceptance test
pnpm human:web -- --prompt "Find the official GPT-5.6 developer page"

# Image input from a local path, URL, or Responses file id
pnpm human:vision -- --image .\sample.png --prompt "Describe this image"
pnpm human:vision -- --image https://example.com/image.png
pnpm human:vision -- --provider openai --model gpt-5.6 --image file-id:file_abc

# Native image output; final files are saved under test-human/output/
pnpm human:image-gen -- --provider openai --model gpt-5.6 --prompt "Draw a small isometric robot"

# Comprehensive tool + memory + compaction run in a disposable workspace
pnpm human:agentcode

# Dynamic coordinator creates three workers that build website features in parallel
pnpm human:a2a-managed

# Stable predefined product engineers build, test, hand off, and integrate the same MVP
pnpm human:a2a-defined

# Hermetic progressive-skill stress suite; no provider or download required
pnpm human:skill-stress -- run --suite offline --parallel 4 --repeat 3

# Focused folder-round and definition-scoped web/workflow skill acceptance
pnpm human:skill-stress -- run --suite offline --scenario harness-folder-rounds --scenario defined-agent-web-skills --parallel 2

# Hermetic customer journeys: use --profile stress or soak for higher pressure
pnpm human:sdk-stress -- --profile complex --seed 20260901

# Live proof: external skills.sh SKILL → tool loop → website → verification
pnpm human:skill-showcase

# Acquire pinned, hash-verified skills.sh fixtures into the project-local cache
pnpm human:skill-stress:prepare

# Exercise the prepared skills with the real Codex provider
pnpm human:skill-stress -- run --suite live --parallel 2

# Real remote MCP over browser OAuth: inspect identity or read a repository file
$env:GITHUB_MCP_OAUTH_CLIENT_ID = '<client id>'
$env:GITHUB_MCP_OAUTH_CLIENT_SECRET = '<client secret>'
pnpm human:mcp:github -- whoami
pnpm human:mcp:github -- read --repo github/github-mcp-server --path README.md
```

`human:agentcode` defaults to a React Todo/Zustand/localStorage task. Its direct
file/search tools are confined to `test-human/workspaces/agentcode`, but npm
scripts are trusted executable code rather than a filesystem sandbox. It stays
interactive after each turn, and text entered while the tool loop is active
becomes safe-boundary steering. See `agentcode/README.md` for the security model,
workspace, token-budget, one-shot, and steering details.

The skill stress harness writes per-case event, request-shape, filesystem-I/O,
trace, and invariant reports below `test-human/results/skill-stress`. Downloaded
skill scripts are never executed. See `skill-stress/README.md` for corpus
provenance, offline/live suites, seeds, repeats, and report layout.

Use `human:skill-showcase` when you want a result a person can open and interact
with rather than only invariant output. It hash-verifies Anthropic's pinned
`frontend-design` skill, asks the live provider to build a Nocturne Rail website
under `test-human/workspaces/skill-showcase/<run-id>`, prints every skill/tool
boundary, and keeps the website plus causal JSON proof.

For OpenAI or Anthropic, pass `--model` or set `AI_AGENT_MODEL`; API keys use the
existing `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` environment variables. Codex uses
the existing project credential store. Run `pnpm provider:codex:login-device`
if it is not signed in.

Provider requests are logged by default to
`.providers/<provider>/logs/YYYY-MM-DD.jsonl`. Report-oriented harnesses also
keep an isolated copy under their result directory, but every live provider
request is mirrored into this project-level aggregate. Add `--no-logs` to
disable both copies.
The A2A website stress harness is deliberately stricter: exact provider logging
is off by default and `--logs` writes only the per-run copy. Its agents receive
identity-scoped write allowlists, and npm-shaped test/build requests are mapped
to fixed Node permission-model processes with a minimal environment instead of
executing model-editable package scripts.
Use `--show-reasoning` to print only reasoning summary/content actually emitted by
the provider. The harness never fabricates or requests hidden chain-of-thought.

## REPL commands

- `/new` resets the current agent session to a fresh conversation.
- `/history` prints sequence numbers and event kinds.
- `/memory` shows durable task memory that is injected outside compactable history.
- `/remember <kind> <text>` pins an `objective`, `constraint`, `decision`, `fact`, `progress`, or `next-step`.
- `/forget <id>` removes one explicit memory item.
- `/compact` creates an immediate context checkpoint while the session is idle.
- `/quit` exits.
- Ctrl+C aborts the active turn; press it while idle to close the CLI.

Validate flags without making a provider request:

```powershell
pnpm human -- --dry-run --scenario web
pnpm human -- --help
```
