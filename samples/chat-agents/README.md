# chat-agents

A Next.js chat surface over the `ai-agent-sdk` agent loop, with the display
model ported from the DeepSeek harness web client: streamed Markdown, typed
tool cards, and the blocking-question card that answers the SDK's
`request_user_input` boundary.

```
samples/chat-agents/
  backend/   @chat-agents/backend — Hono app: agent runs, SQLite state, credentials, workspace
  web/       @chat-agents/web     — Next.js 16 app: rendering, IndexedDB transcript cache
```

## Running it

```bash
pnpm install
pnpm --filter @ai-agent-sdk/core build        # the backend consumes built dist output
pnpm --filter @chat-agents/web dev            # http://localhost:3000
```

Nothing has to be configured on disk: open **Settings** and either sign in with
Codex (OAuth device code) or paste an API key for Gemini, OpenAI, or Anthropic.
Environment variables (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
read from the repository root `.env`) act only as a seed for a first run; a key
saved in the UI overrides them.

Sample-local state, all git-ignored:

| Path | Contents |
| --- | --- |
| `.data/chat-agents.db` | SQLite: groups, conversations, transcripts, agent history, agent presets, MCP servers, skill roots, credentials |
| `.workspace/` | The default sandbox the agent may read |
| `../../.providers/.codex/auth.json` | Codex OAuth tokens (repository-local, never the Codex CLI's own file) |

## How the pieces fit

**Dependencies, not paths.** `@chat-agents/backend` depends on
`@ai-agent-sdk/core`, `@ai-agent-sdk/auth-node`, and the provider packages
through `workspace:*`; the web app depends on the backend the same way and
compiles its TypeScript sources via `transpilePackages`. Nothing reaches across
directories with a relative import.

**One API surface.** `src/app/api/[[...route]]/route.ts` forwards every
`/api/*` request to the Hono app. The Next.js layer holds no request logic.

| Route | Purpose |
| --- | --- |
| `POST /api/chat` | Run a prompt; responds with an SSE stream of wire events |
| `POST /api/answer` | Answer a parked `request_user_input` question |
| `POST /api/abort` | Cancel the conversation's in-flight run |
| `GET /api/groups`, `POST/PATCH/DELETE /api/groups[/:id]` | Groups (projects): name and workspace |
| `GET /api/conversations?groupId=` | List a group's conversations, newest activity first |
| `GET /api/conversations/:id` | Conversation row plus its stored transcript |
| `PATCH /api/conversations/:id` | Rename, or set provider/model, reasoning effort, loop mode, agent preset, workspace |
| `GET/POST /api/groups/:id/agents`, `PATCH/DELETE /api/agents/:id` | Agent presets |
| `GET/POST /api/groups/:id/mcp`, `PATCH/DELETE /api/mcp/:id` | MCP servers and their live status |
| `GET/POST /api/groups/:id/skills`, `PATCH/DELETE /api/skills/:id` | Global skill folders (project folders are scanned automatically) |
| `DELETE /api/conversations/:id` | Delete a conversation and its transcript |
| `GET /api/providers` | Providers, readiness, key hints, endpoint overrides |
| `GET /api/providers/:id/models` | Discovered catalogue (Codex) or suggestions |
| `PUT /api/providers/:id/credential` | Store or clear an API key and endpoint |
| `GET/POST /api/auth/codex[...]` | Device-code sign-in: state, start, cancel |
| `GET/PUT /api/workspace`, `GET /api/workspace/browse` | Read, set, and browse the agent's directory |

**Credentials live on the server.** Keys are written to SQLite and handed to an
adapter as a resolver function, so an edit applies to the next request without
rebuilding the registry. No route ever returns a key — only its last four
characters. The keyed providers also accept an endpoint override, which is how
you point OpenAI at a gateway or proxy.

**A project is a folder.** Creating one means picking a directory in the
project dialog (the browser runs server-side, because a web page cannot hand
over a real path); the folder's own name becomes the project name. A project
holds many conversations, and every tool a conversation runs stays inside that
folder. Switching project in the sidebar switches the workspace and the
conversation list at once, which is how one app serves several codebases.

**Settings are global.** Provider credentials, agent presets, MCP servers, and
skill folders apply to every project — a project carries no configuration of
its own beyond its folder.

**The composer bar owns the run settings.** Model, reasoning effort, and loop
policy are chips on the input bar, each writing straight to the conversation
row — what the bar shows is what the next turn uses. Only providers with a
working credential appear in the model list.

Effort levels are per model, not per provider, and are read from the SDK rather
than hard-coded: `listModels` returns `ModelInfo`, which carries no reasoning
metadata, so the backend resolves each route through
`ModelRegistry.resolveModelInfo()` and reads `reasoning.efforts` /
`reasoning.defaultEffort`. The HTTP adapters resolve from the catalogue
connection they already cached, so this costs no extra request. A Codex route
therefore offers `low · medium · high · xhigh · max` (and `ultra` where the
account exposes it); a model that discloses nothing falls back to the generic
`minimal · low · medium · high` ladder.

**Multiple agents.** The composer's loop chip picks the shape of a run:

| Mode | Shape |
| --- | --- |
| `basic` / `deep` / `deep-human-in-loop` | one agent, the bounded `runAgent` loop |
| `team` | a declared roster: the selected preset leads and delegates to every preset marked **In team**, using the SDK's `list_agents` / `send_message` / `wait_agents` / `followup_task` tools |
| `team-dynamic` | one lead that calls `spawn_agent` to create workers as the task demands, several running in parallel |

Team runs use `defineAgent` + `AgentSession` rather than `runAgent`, because a
team needs addressable sessions with their own history. Members report through
`AgentTeam.onAgentEvent` / `onWorkerEvent`, so every member's tool calls and
text land in the same transcript, tagged with who wrote them; the roster strip
above the composer shows who is working and lets you filter the transcript to
one member.

One caveat worth knowing: a `DefinedAgent` always sends a reasoning effort, and
a provider that declares none (Gemini today) rejects any value. That is why the
single-agent modes stay on `runAgent`, which accepts an omitted effort, and why
team modes need a model that publishes efforts — Codex routes do.

**Agents, MCP, and skills.** An agent preset replaces the system prompt and may
pin its own model, loop policy, and effort. Every enabled MCP server (stdio or
streamable HTTP) is connected on demand and its tools are merged into the run —
a workspace tool always wins a name clash, and a failing server surfaces its
error instead of breaking the turn. Skills come from two places: every project is scanned
automatically for `.agents/skills` and `.dsh/skills` from its folder up to the
repository root, and the Skills tab adds global folders available in every
project. Either way the model sees names and descriptions first, then calls
`load_skill` for the full instructions.

**The agent is confined to a workspace.** Every filesystem tool resolves paths
inside its project's directory and refuses to escape it. The default project
starts on the `.workspace` sandbox next to the sample; the project dialog moves
it, or opens any other folder as a new project.

**Two kinds of persistence.** SQLite holds what the *agent* needs — the
`History.snapshot()` of each conversation, so a turn after a server restart
still has its context — plus the rendered transcript. IndexedDB in the browser
caches the same transcript so a reopened conversation paints instantly; the
server copy is authoritative and overwrites it. Drizzle owns the schema
(`src/db/schema.ts`), `pnpm --filter @chat-agents/backend db:generate`
regenerates the migrations, and the runtime applies those same SQL files
through Node's built-in `node:sqlite` driver — no native build step.

**Loop policy is the user's choice.** `basic` answers once. `deep` makes the
model pass a `submit_result` self-check, so a run answers, submits, then answers
**again** — that is why a deep run shows two assistant messages around a
Self-check row. `deep-human-in-loop` adds the blocking question card
(`request_user_input`). The two team modes are described above.

**The wire protocol is display-shaped.** `backend/src/wire.ts` defines what the
frontend sees: text deltas, reasoning deltas, tool calls, tool results carrying
a typed `ToolCard`, questions, usage, and run lifecycle. The frontend never
imports the SDK's own event union, so the loop can change without touching the
UI.

**Tool cards come from the tool.** Each tool in `backend/src/tools.ts` returns
`meta.card`, the SDK's UI-metadata channel that the model never sees. That is
what turns a result into a read, diff, search, web, or todo card.

## What was ported from the harness

- `web/src/ui/primitives/` — the harness's cordis-free React primitives verbatim:
  the mdast→React Markdown renderer (incremental block caching while streaming,
  Shiki highlighting, KaTeX, protocol allowlist, raw HTML kept literal) plus the
  terminal, read, diff, search, web, and JSON blocks.
- `web/src/styles/` — the `--dsw-*` design tokens; dark mode is
  `body[data-ds-dark-theme]`, driven by a System/Light/Dark preference.
- The shell, tool row, question card, and settings dialog are rebuilt against
  those tokens; the cordis plugin/slot framework and the WebSocket session
  protocol are not part of this port.

## Not built yet

Attachments, the details/trajectory column, multi-agent orchestration (presets
are single agents, not a team), per-tool permission policy, multi-user auth, and
encryption of the stored API keys (the database file is git-ignored but
plaintext).
