# chat-agents

A Next.js chat surface over the `ai-agent-sdk` agent loop, with the display
model ported from the DeepSeek harness web client: streamed Markdown, typed
tool cards, the blocking-question card that answers the SDK's
`request_user_input` boundary, and the permission card that answers its
approval boundary.

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
| `.data/chat-agents.db` | SQLite: groups, conversations, transcripts, agent history, agent presets, MCP servers, skill roots, credentials, standing tool permissions |
| `.workspace/` | The default sandbox the agent reads, and writes to once permitted |
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
| `POST /api/steer` | Add a message to the run in flight instead of waiting for it |
| `POST /api/answer` | Answer a parked `request_user_input` question |
| `POST /api/approve` | Permit or refuse a parked tool call, with a scope of `once`, `session`, or `workspace` |
| `GET/POST /api/groups/:id/permissions`, `DELETE .../:ruleKey` | Standing project-wide grants |
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
| `team-dynamic` | one lead that calls `spawn_agent` to start workers and keeps working while they run, reading their results as they report back. Workers are spawned with `defaultSpawnContext: 'fork'`, so each starts already knowing what the lead found out about the workspace instead of rediscovering it. Three roles are declared — `implementer`, `investigator`, `reviewer` — and the lead orders the plan with `dependsOn` and claims files with `writes`, so a reviewer waits for the code it reviews and two workers cannot be given the same file |

Team runs use `defineAgent` + `AgentSession` rather than `runAgent`, because a
team needs addressable sessions with their own history. Members report through
`AgentTeam.onAgentEvent` / `onWorkerEvent`, so every member's tool calls and
text land in the same transcript. A member's consecutive rows are grouped into
one named, indented panel rather than badged individually: drawn at the lead's
level the transcript read as a single agent talking to itself, and the rule down
the side is what says "this part is not the orchestrator". A member is marked
finished on its OWN `agent-end`, not at the run's teardown — closing them all at
the end left every subagent shown as busy long after its work was visibly done.
The roster strip above the composer shows who is working and filters the
transcript to one member.

In `team-dynamic` the harness belongs to the CONVERSATION, not to one run. A
worker outlives the run that spawned it — that is the SDK's contract, so the
lead can keep working while its workers do — which means rebuilding the harness
per prompt would strand the previous prompt's workers with nothing left to stop
them. The session keeps it, `forgetSession` disposes it, and worker events that
arrive after a stream has closed are persisted and flushed by the next run's
stream rather than dropped. `onWorkerEvent` is a stable indirection into the
session for the same reason: the harness captures its callback once, so a
per-run callback would still be delivering to a run that ended two prompts ago.

Because the lead can answer before its workers do, the SSE stream stays open
after the lead's `run-end` for as long as any worker is still running, with the
status line naming them. Closing there would leave the reader with an answer and
no sign of the agents still working behind it — they would only find out on their
next prompt. The stream gives up that watch the moment a new prompt claims the
conversation, since two streams draining the same outbox and numbering the same
transcript would interleave.

The roster alone is not enough to decide when to stop. A worker's last event
fires before its run resolves, and the completion report that wakes the lead is
delivered after that — so for a moment every member looks idle, and a stream
that believed it would close one instant before the synthesis, leaving the
conversation ending on a worker's own output. `ManagedAgentTeam.whenQuiet()`
covers that gap: a worker settles only once its report has been delivered, so
the wait resolves with the lead already woken.

Settled workers are then closed. The SDK keeps a finished worker addressable —
and occupying one of `maxWorkers` — until something closes it, which is what
makes `close_agent` worth calling; but this app holds one harness for a whole
conversation, so a lead that forgot would exhaust the cap after a few prompts and
every later spawn would fail. Their answers are already in the lead's history and
in the transcript, so reclaiming the slot costs nothing.

The run's live status — `Still running a command · 40s`, or the invitation to
steer — sits at the END of the stream, where the next row will appear, the same
place Claude Code and Codex put it. Under the composer it read as chrome about
the input box rather than as the run's own last line.

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
inside its project's directory and refuses to escape it, and `run_command` runs
with that directory as its working directory. The default project starts on the
`.workspace` sandbox next to the sample; the project dialog moves it, or opens
any other folder as a new project.

**Changing the machine asks first.** The tool set splits in two.
`read_file`, `list_directory`, `search_files`, `propose_edit`, `write_todos`,
`fetch_url`, and the SDK's own `read_tool_output` (which reads back output that
was spilled — see below) run unattended. `write_file`, `edit_file`, `delete_path`,
`create_directory`, `move_path`, and `run_command` are listed in
`MUTATING_TOOLS`, and `backend/src/approvals.ts` turns each of them into a
question before it runs — using the SDK's own seam, not a wrapper around the
tools: a `ToolInterceptor` returns `ask`, the loop parks *that one call* on an
`ApprovalBroker`, and the rest of the turn keeps streaming. The card takes over
the composer with the change it is about to make — the diff that would be
written, the command that would run — and the answer chooses its own reach:

| scope | remembered in | lost when |
| --- | --- | --- |
| Just once | nothing; the parked call consumes it | immediately |
| This chat | the live conversation | the conversation ends |
| This project | SQLite, keyed by workspace root | the grant is revoked |

A grant covers a *family* of calls, not one call: the tool name, or
`run_command:<executable>`, so approving `git status` for the project does not
also approve `rm`. Refusing is an answer the model sees and can work around —
it is not the same as cancelling the run, which is what the stop button does.
`GET`/`POST`/`DELETE /api/groups/:id/permissions` lists, adds, and withdraws
the standing project-wide grants.

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

**You can talk to a run that is already going.** Typing while the agent works
steers it instead of queueing behind it: the message is appended to the agent's
history through the SDK's `AgentSession.inject` — the primitive A2A quiet
delivery uses — and because `runTurn` rebuilds its request from history on every
model round, the turn already in progress reads it. Correcting a wrong turn no
longer means stopping the run and starting over. Send and Stop sit side by side
during a run, so redirecting is never one misclick from cancelling.

**A run wakes for more than its own events.** The lead's event stream is not the
only producer: a team member reports through a callback and permission answers
arrive on their own request. `runSteps` merges them, and that is load-bearing
rather than tidy — iterating the lead alone deadlocked team runs. A lead blocks
inside `wait_agents` until a member goes idle, a member parked on a permission
prompt cannot go idle until that prompt reaches the browser, and the prompt was
only flushed by a lead event that would never come. Nothing times out of that,
so the run hung permanently.

**Failures are retried, and slowly is not silently.** The SDK ships neither
policy on purpose: `runTurn` asks `hooks.onRequestError` whether to retry and
fails when no host answers, and it caps a model stream at ten minutes. Both are
right for a library and wrong for a chat window, so `backend/src/resilience.ts`
supplies the host half — a bounded retry (3 attempts) for transient failures
only, honouring a provider's `Retry-After` with jittered exponential backoff
otherwise, and a five-minute stream deadline. A rate limit or a dropped socket
is worth another attempt; a bad API key fails identically every time. Every
retry is announced in the transcript, because a silent recovery is exactly how a
stalled run gets mistaken for a working one.

That deadline was 90 seconds and both halves of it were wrong. It is a **hard
deadline for a whole stream**, not an idle timer — the SDK arms it once before
the request and never resets it on a chunk — so it has to exceed the longest
legitimate generation, and a reasoning model at medium effort routinely streams
a tool-heavy turn past 90 seconds, the more so once several subagents share one
provider. And `MODEL_TIMEOUT` was in the retryable set, so every kill was
retried into the same wall: three full generations spent to fail anyway. Our own
deadline expiring is now permanent for that request; the provider's own
`TIMEOUT`, a transport failure a second attempt can get past, still retries.

**A running command is watched, not awaited.** A tool result is delivered
once, when the tool returns, so everything a two-minute `create-next-app`
prints would be invisible until it exits — the row said "Run" and nothing
else. `ToolRunContext` offers no channel for partial output, so `run_command`
publishes its stdout and stderr on a module-level bus tagged with the call id,
coalesced on a 200ms timer because a build prints in bursts of tiny writes.
The bus is module-wide rather than a constructor argument because tool
registries are cached per workspace root and shared by every conversation in
that folder; a run picks out the call ids it owns, so one chat's build is never
narrated into another's. The row opens itself while output is arriving and
draws its own live pane — `TerminalBlock` is a verbatim port that deliberately
shows the prompt line alone while running, and handing it a settled shape
instead would put a green "Done" dot over a command still going.

**A quiet run says what it is waiting on.** Silence is not a fault: a reasoning
model is silent before its first token, `npm install` is silent for minutes, and
a lead inside `wait_agents` is silent for as long as its member works. Every one
of those is already bounded by the SDK — a model round by `MODEL_TIMEOUT_MS`, a
tool call by the loop's `maxToolDurationMs`, and waiting on a member IS a tool
call — so nothing here is missing a timeout. What is missing is the telling: ten
minutes inside a legitimate bound looks exactly like a hang when the window says
nothing. So `createIdleWatch` reports instead of accusing. After twenty quiet
seconds the composer's hint becomes `Still running a command · 40s`, updating
while the silence lasts, and it is a live status line rather than a transcript
node because "still installing (40s)" is untrue the moment the run moves on.
A member reporting counts as activity — a team run is alive as long as any of
its agents is producing — and time spent waiting on a parked permission prompt
counts for nothing, because then the run is waiting on a person.

Nothing here ever ends a run. An earlier revision of this file described a
watchdog that warned at 45 seconds and aborted at five minutes; it was wrong
twice over. It judged the silence before recording the event that had just ended
it, so it warned at the exact moment a run resumed, and an automatic abort would
have killed a legitimate `npm install` that had simply not printed anything yet.

**The wire protocol is display-shaped.** `backend/src/wire.ts` defines what the
frontend sees: text deltas, reasoning deltas, tool calls, tool results carrying
a typed `ToolCard`, questions, permission prompts, retry notices, usage, and run lifecycle. The frontend never
imports the SDK's own event union, so the loop can change without touching the
UI.

**Token spend is counted from two sources.** `backend/src/usage.ts` records one
row per model call, grouped in Settings → Usage by provider, model and reasoning
effort, with cached input kept apart from fresh input. A provider that streams
its counters is counted per call; one that reports only when a turn ends is
counted from the turn's own accounting, and the second source records just the
difference so neither is double counted. A provider that reports nothing at all
stays at zero — the SDK flags its estimates as estimates, and showing a guess as
a measurement would be worse than an empty table.

**Oversized tool output is spilled, not cut.** `backend/src/spill.ts` implements
the SDK's `SpillStore` over files next to the database, and mounts it on every
session. A result above the turn's token budget therefore leaves the model a
preview plus a locator instead of spending the context window, and
`read_tool_output` reads or greps the rest — nothing is lost. The files live
under `.data/spill`, never in the workspace: the agent's own file tools are
confined to the workspace, and spill inside it would let one run read or delete
another conversation's output through the ordinary read and write tools. A
locator travels through the model, so it is matched against a strict shape
before it is ever joined to a path, and a startup sweep removes files older than
seven days.

Without a store mounted the SDK truncates the middle instead, which needs no
storage; the sample mounts one because it keeps conversations across restarts
and a locator that stops resolving is worse than an honest cut.

**Tool cards come from the tool.** Each tool in `backend/src/tools.ts` returns
`meta.card`, the SDK's UI-metadata channel that the model never sees. That is
what turns a result into a read, diff, search, web, todo, or filesystem card.

## What was ported from the harness

- `web/src/ui/primitives/` — the harness's cordis-free React primitives verbatim:
  the mdast→React Markdown renderer (incremental block caching while streaming,
  Shiki highlighting, KaTeX, protocol allowlist, raw HTML kept literal) plus the
  terminal, read, diff, search, web, and JSON blocks.
- `web/src/styles/` — the `--dsw-*` design tokens; dark mode is
  `body[data-ds-dark-theme]`, driven by a System/Light/Dark preference.
- The shell, tool row, question card, permission card, and settings dialog are
  rebuilt against
  those tokens; the cordis plugin/slot framework and the WebSocket session
  protocol are not part of this port.

## Not built yet

Attachments, the details/trajectory column, multi-agent orchestration (presets
are single agents, not a team), multi-user auth, and
encryption of the stored API keys (the database file is git-ignored but
plaintext).
