# chat-agents

A Next.js chat surface over the `ai-agent-sdk` agent loop, with the display
model ported from a production chat web client: streamed Markdown, typed
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

After SDK changes, rebuild core and restart the dev server. See
[Team-auto research regressions](RESEARCH-REGRESSIONS.md) for completion behavior,
budget handling, automated checks, and research/coding/analysis reproduction prompts.

Team and Team-auto use `maxTurns: 'auto'` for leads and workers, so a long task
can continue past the former 32/48-step ceilings. Single-agent modes retain
32 steps. Auto removes the step ceiling; token, loop, timeout and ledger limits
still apply. Hosts using the SDK can choose a positive numeric `maxTurns` for
a fixed work budget. The sample keeps tool-call counts advisory with
`onExhausted: 'continue'`.

Total-token policy defaults to `maxTotalTokens: 'auto'` in both SDK and sample:
there is no aggregate token ceiling or token-reserve shutdown. Hosts can set
`runtimeLimits: { maxTotalTokens: 500_000, finalReportReserveTokens: 100_000 }`
to opt into a fixed budget and reporting reserve. Model context/output limits,
timeouts, loop guards and run-ledger limits still apply.
`fetch_url` includes bounded source links as well as readable
text, so research can follow real URLs. Codex catalogue refresh failures may
reuse recently verified metadata for up to 30 minutes beyond its normal cache
lifetime; successful refreshes replace it immediately.

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
| `POST /api/attachments` | Store one attached file (raw bytes; name and type in headers) |
| `GET /api/attachments/:id` | Serve one stored attachment |
| `GET /api/attachments/limits` | The admission limits the composer enforces before uploading |
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
| `GET /api/conversations/:id/traces` | The conversation's runs, newest first: status, start, duration, span count |
| `GET /api/traces/:runId` | Every span of one run, for the tree and its details |
| `GET /api/providers` | Providers, readiness, key hints, endpoint overrides |
| `GET /api/providers/:id/models` | Discovered catalogue (Codex) or suggestions |
| `PUT /api/providers/:id/credential` | Store or clear an API key and endpoint |
| `GET/POST /api/auth/codex[...]` | Device-code sign-in: state, start, cancel |
| `GET/PUT /api/workspace`, `GET /api/workspace/browse` | Read, set, and browse the agent's directory |

**Attachments are two different things.** An image is model input: it is
base64-encoded into a user message's `ImageBlock` on every turn that replays
it. A generic file is material — a text-ish one is inlined into the prompt so
the model can read it at all, and anything else is named, sized, and located,
because the agent's filesystem tools are confined to the workspace and
attachments deliberately live outside it. Both are admitted before storage
(byte, pixel, and per-side limits, plus a magic-byte check that the bytes are
what the browser claimed), content-addressed under `.data/attachments`, and
served back by id so a reloaded conversation still shows the screenshot the
question was about.

Files upload the moment they are picked — by the paperclip, by paste, or by a
drop anywhere on the page — so each has its own progress and its own retry, and
send is disabled only for as long as an upload is still running. A picture
attached to a model that declares no image input is refused before the turn
starts rather than silently replaced with an "image omitted" note: a request
that runs is not the same as a request that was understood.

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
text land in the same transcript. A member's rows are gathered into ONE named,
indented panel rather than badged individually: drawn at the lead's level the
transcript read as a single agent talking to itself, and the rule down the side
is what says "this part is not the orchestrator". The panel gathers ALL of that
member's rows, not each consecutive run of them — members work in parallel, so
their rows arrive interleaved, and a nine-minute run with three agents drew
forty-three panels. Gathering costs the ordering BETWEEN two members, which
nobody could read anyway, and keeps the ordering that means something: the panel
sits where the member first appears, which is the lead's own `spawn_agent` call.
Each panel folds, closed once its member is done, and its header carries the
member's step count — but deliberately no duration: a member's rows are handed
over in bursts when the lead next wakes, so their stamps say when the run
delivered the work, not how long the member spent on it. A member is marked
finished on its OWN `agent-end`, not at the run's teardown — closing them all at
the end left every subagent shown as busy long after its work was visibly done.
The roster strip above the composer shows who is working and filters the
transcript to one member. It outlives the run that made it: the live roster is
empty once the run ends and gone after a reload, so it falls back to the members
found in the transcript itself — a stored team conversation can still be read one
agent at a time. Filtering to a member always opens that member's panel, whatever
its status: asking for one agent IS asking to see its work, and the folded
default made every chip on the strip show the same one-line header. A member with
nothing in the transcript yet says so by name rather than leaving the column
blank, and a filter set in one conversation is dropped when the next one has no
such member.

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
project (`CHAT_AGENTS_USER_SKILLS=1` adds `$HOME/.agents/skills` on top).
Either way the model sees names and descriptions first, then calls `load_skill`
for the full instructions.

**Naming a skill with `/`.** That last sentence is also the problem: a skill is
loaded when the *model* decides it applies, which leaves the user describing it
in prose and hoping. Typing `/` in the composer opens a menu of the skills this
project actually has — the same providers the run uses build it
(`backend/src/skill-catalog.ts`), so the menu can never offer one the run would
not find — and picking writes `/<id>` into the message.

It stays a **mention, not an execution**. The backend matches the `/` tokens
against the catalogue and prepends one line asking the model to `load_skill`
each match before acting; the skill's own instructions are never spliced in, so
a skill named by mistake is a sentence the model can disregard rather than a
body of rules already in its context. The catalogue is also the allowlist, which
is why `read /etc/passwd` names nothing and `src/ui` never opens the menu. The
directive goes to the model only — the transcript stores what the user typed,
with a chip naming the skills that actually matched, so "did it use the skill"
has a visible answer.

Picking from the menu **detaches** the mention: the `/word` leaves the draft and
the skill becomes a chip beside the text, so the message reads as a sentence and
what is attached is something you can see and remove (click its ×, or Backspace
at the start of an empty draft) rather than a word you have to notice and edit
out. The ids travel next to the prompt as `skillIds`.

Typing `/id` by hand still works, and there the mention is **coloured text** —
a bordered chip inside the text read as an input field sitting inside the input
field. A textarea cannot colour part of its own value, and swapping it for a
contenteditable box would trade a working composer — IME, undo, paste, autosize
— for a visual, so `MentionHighlights` mirrors the draft behind it and draws the
text while the textarea's glyphs go transparent (its caret does not). That only
happens while a typed mention is present; with none the textarea is left alone.
Nothing but the colour may differ between the two layers: the caret is still
placed by the textarea, so a bolder or larger mention would put every character
after it off its own caret. Only a mention that MATCHES the catalogue is
coloured, so an unrecognised `/word` staying plain is the signal that it will not
load anything — and the backend reconciles both paths, chips first, against that
same catalogue, so an id the browser invents attaches nothing. The rules themselves — where a trigger opens,
how matches rank, what a completion writes, which spans are mentions — live in
`web/src/ui/chat/mentions.ts` with no React in them, which is what lets the
UI's rules be tested against the backend's in one spec without a browser. Mentions work identically mid-run, where the message
steers the agent instead of starting a turn.

**`AGENTS.md` is always on; a skill is not.** The two look similar and are
opposite contracts. A skill is advertised by description and loaded when the
model decides it is relevant. Project instructions are the conventions the work
has to follow whether or not the model thought to ask — an agent that never read
them has already broken them. So they arrive through
`@ai-agent-sdk/instructions-node`, mounted as a `contextSections` entry on every
agent in the group (`instructionsFor` in `backend/src/agent-runtime.ts`).

A context section, not `instructions` text, because the system prompt is the
prompt-cache prefix and these files change WHILE a session runs: the agent reads
into a new folder, or someone edits the file mid-conversation. A section owns one
node on the conversation surface, is re-resolved before every model round, and
rewrites itself only when its revision changes — so an edit lands on the next
round for free, and nothing invalidates the cached prefix. Discovery is
broad-to-specific with `AGENTS.override.md` beating `AGENTS.md` in the same
folder, and a directory the agent *reads into* contributes its own file from that
point on (the sample's tools name the argument `path`, which is what the SDK's
default touch reader looks for).

Two deliberate departures from the package defaults:

- `projectRootMarkers: []`, so the walk stops at the **workspace root**. The
  default (`['.git']`) walks up to the enclosing checkout, which for a project
  opened inside a larger repository would put a file the agent's own tools are
  forbidden to read into every prompt. `CHAT_AGENTS_INSTRUCTIONS_WALK_UP=1` opts
  back into the package behaviour.
- No global file unless `CHAT_AGENTS_GLOBAL_INSTRUCTIONS` names one. Where a
  host keeps a user's standing instructions is the host's decision.

Because an always-on section is silent by design, the **AGENTS.md tab** answers
the one question it cannot: which files are actually in the prompt right now,
in the order the model sees them, with the first line of each.
`GET /api/groups/:id/instructions` is that list, and it mirrors the runtime's own
discovery (`backend/src/instructions.ts` reuses the SDK's root-finding rather
than reimplementing the precedence). Subtrees picked up mid-run are left out —
they depend on what the agent has opened so far, and a pane that changed while a
run progressed would be noise.

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

A grant covers a *family* of calls, not one call, and the card asks for the
family's **width** next to the scope's duration — a second row of chips,
narrowest first:

| rule key | covers |
| --- | --- |
| `run_command:prefix:git diff` | every `git diff …` command |
| `run_command:prefix:git` | every `git` command |
| `write_file:dir:src/ui` | writes under `src/ui/` |
| `write_file` | writes anywhere in the project |

So "allow `git diff` for this project" can exist without also meaning "allow
`git push`". `describeMutation` derives both halves — the widths to offer and
every key that would cover the pending call — so the store is still checked by
equality and nothing re-parses a command line at match time. What a width may
say is where the care goes:

- A line that is more than a plain argument list offers nothing: `&&`, a pipe,
  `$VAR`, a substitution, a redirection, a backslash. The prefix would label a
  line it does not decide. Quotes are fine — they only group words — so
  `git commit -m "two words"` still scopes to `git commit`.
- The program word keeps its path. `git` is whatever `PATH` resolves; `./git`
  is a file the agent can write, so it gets its own key and can never ride a
  grant made on the name `git`.
- Executables that must not be signed away wholesale (`rm`, `sudo`, `bash`,
  `curl`, …) are never offered, read through the path and case-insensitively.
- Paths are resolved the way the tools resolve them, so a rule is derived from
  the path that will actually be written — `src/ui/../lib/x.ts` scopes to
  `src/lib`, and a file whose *name* contains a separator for another platform
  stays one name rather than a directory a grant could widen through.
- A width nobody can read is not a width: chips naming a very long word or a
  very deep directory are dropped rather than shown.

A key added by hand through the permissions API is still honoured in every one
of those cases, and the key the prompt settles on — never the one the client
asked for — is what gets stored.

**A destructive line says so, in words.** The workspace root confines the
filesystem tools; it does NOT confine a shell. `run_command` fixes the working
directory and hands the rest of the line to the platform shell, so `rm -rf ~`,
`del /s /q C:\Windows`, `diskutil eraseDisk` and `echo x > /etc/hosts` are
ordinary command lines as far as the tool is concerned — and a card that renders
them as one more grey line of monospace is a card that gets approved by reflex.
`backend/src/hazards.ts` reads the line before it runs and the card leads with
what it found: a red banner above the command, the safe answer as the prominent
button, two clicks to allow instead of one, and no grant offered at all (a line
worth warning about is a line worth asking about every time).

What it reads, on every platform the sample runs on:

| recognised | examples |
| --- | --- |
| the filesystem root, home, system directories | `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `del /s /q %SystemRoot%`, `rd /s /q C:\`, `Remove-Item -Recurse -Force $env:USERPROFILE` |
| any path that simply is not in the workspace | `rm -rf /work/other`, `rm -rf ../..`, `rm -rf D:\backups` |
| disks, volumes, and the ability to restore | `mkfs.ext4`, `diskutil eraseDisk`, `format D:`, `diskpart`, `Clear-Disk`, `vssadmin delete shadows`, `tmutil delete`, `dd of=/dev/disk0` |
| deletes that never name a deleter | `find / -name '*.log' -delete`, `find /Users -exec rm -f {} +`, `rsync -a --delete ./ /Volumes/Backup/` |
| writes and moves that leave the workspace | `echo x > /etc/hosts`, `cat junk >> ~/.zshrc`, `mv secrets.env /dev/null` |
| permissions rewritten on the machine | `chmod -R 000 /`, `sudo chown -R root /usr` |
| work nothing can restore | `git clean -xdf`, `rm -rf .` (the workspace root itself) |
| a target that cannot be read yet | `rm -rf $BUILD_DIR`, `rm -rf \`echo /\`` — the empty-variable disaster, reported as unknown rather than guessed |

And what it reads THROUGH, because each of these hid a delete behind one extra
word: `sudo` and `FOO=1` prefixes, a path or `.exe` on the program
(`/bin/rm`, `del.exe`), shell wrappers (`sh -c "rm -rf /"`, `ls | xargs rm -rf`,
`powershell -Command "Remove-Item …"`), containers and remote shells
(`ssh host "rm -rf /"`, `docker run -v /:/host … rm -rf /host`), a `cd` earlier
in the same line (`cd /etc && rm -rf .`), and a path that starts somewhere safe
and ends somewhere else (`/tmp/../etc`). Scratch directories (`/tmp`,
`/var/folders`, `%TEMP%`) read as a warning rather than as destruction, because
a card that shouts at `rm -rf /tmp/build-cache` teaches the user to click through
shouting.

It is **not** a sandbox and must not be read as one: an empty hazard list means
nothing recognisable was found, not that the line is safe.
Refusing is an answer the model sees and can work around —
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

**A finished turn folds into one line.** The transcript is cut into turns —
one prompt, the work, the answer — and once a turn is over its work collapses
behind `Worked for 2m 31s · 15 steps`, which opens again on click. Flat, the
two paragraphs the user asked for sat at the same level as the forty tool rows
that produced them, and finding the answer meant recognising it. Only the lead's
own finished prose counts as the answer: a member's text is its report to the
lead, and commentary is the agent narrating itself on the way. A failure or a
question still waiting on the user counts too, so a fold can never hide why a
turn stopped, and a turn that produced no answer stays open — folding it would
leave a summary line with nothing under it. The turn still running is never
folded, because while it runs the work IS what there is to read. The duration
comes from the rows themselves: each is stamped as it settles, and a reload
takes the stamp from the message's own `created_at`, so a transcript read back
from SQLite can still say how long it took. `web/src/ui/chat/turns.ts` holds
the split, apart from the view, because where the answer begins is a judgement
about the agent's output rather than about React.

**Nesting has three levels, not one.** A finished turn folds; inside it a run
of consecutive tool calls folds behind `Fetch, Run · 9 steps`; inside that each
call folds its own output. The middle level is the one that was missing, and it
is the one that matters at scale: an agent works in long stretches of calls with
a sentence of prose between them, so drawn flat a hundred-and-nineteen-step run
buries the four lines where the agent said what it was doing. Three consecutive
calls is the shortest run worth folding — two rows are not a wall, and hiding
them costs a click to learn less than the rows already said. A call still
RUNNING is never folded into a run: it is the row the user is watching. A run
holding a failure opens itself and says `· 1 failed` on its summary, because a
fold that hides a failure is hiding the one row the reader came for.

**A run belongs to its conversation, not to the window on it.** Switching
conversations used to abort the reader, and the backend treats a dropped reader
as cancellation — so glancing at another chat killed the work you were waiting
for, silently. Runs are now held in a map keyed by conversation
(`useChat`'s `runs`): each one accumulates into its own buffer, and the screen
mirrors whichever conversation is open. Come back and it is still going, with
everything it produced while you were away. Two consequences are wired through
the same map: the transcript loader skips a conversation that has a live buffer,
because the cache and the server's settled copy are both BEHIND it; and every
edit a person makes mid-run — answering a permission prompt, steering — goes
through `editNodes`, which writes the buffer as well as the screen, or the next
event would repaint over it. Deleting a conversation is the one case that still
aborts: nothing is left for the run to write into.

**The header says where you are.** `<project> › <conversation>`, with the
project first: which project is open decides what every tool in a run can read
and write, and the header used to name only the conversation, with the project
reduced to a folder chip at the far right where it read as a setting rather than
as the place the work is happening. The crumb opens the project dialog, its
tooltip is the workspace path — two projects can share a folder basename — and
when the header runs out of room the project keeps its name while the title
truncates, because a half-shown project name is the one part of that line that
could be read as the wrong project.

**Projects are listed, and their conversations hang under them.** The sidebar
opens with **New chat** as a row of its own — it is the thing a user does more
often than anything else in that column, and as an icon in the header it was a
28px target sharing a line with two others, identifiable only by hovering it.

Below it, projects are listed rather than hidden behind a picker, and the open
project expands to show its conversations indented beneath it with a rule down
the left. A conversation belongs to exactly one project, so two flat lists made
the reader join them up by inference; only the open project can expand, because
it is the only one whose conversations the browser holds. A closed project shows
its conversation count instead — computed in one grouped query on the server for
that same reason. Clicking the open project folds its chats away; clicking
another switches to it, which already starts a fresh conversation. Each row's
hover action follows from that: a new chat on a project, a delete on a
conversation, drawn ON the row rather than beside it, because a list that
reflows under the cursor is a list you click the wrong thing in. Long lists page
with "Show more" rather than scroll, and a raised limit resets when the project
does.

**The sidebar shows a run you walked away from.** The conversation row exists
from the moment the run starts — the server creates it before its first event —
but the list only ever refreshed when a run ENDED, so a conversation started and
left to work was invisible for as long as it took. It refreshes at the start
too, and a conversation with a run in flight is marked `Working…` with a live
dot, whichever one you are reading.

**The wire protocol is display-shaped.** `backend/src/wire.ts` defines what the
frontend sees: text deltas, reasoning deltas, tool calls, tool results carrying
a typed `ToolCard`, questions, permission prompts, retry notices, usage, execution
spans, and run lifecycle. The frontend never
imports the SDK's own event union, so the loop can change without touching the
UI.

**Every run leaves a trace.** The transcript says what the agent produced; the
**Trace** button in the header says how it got there. The SDK emits
OpenTelemetry-shaped span events on the same stream as the text and the tool
calls — `span-start` when a step opens, `span-end` when it closes with a status,
a duration, and its token counters — and `backend/src/traces.ts` keeps them.
Each span is written when it opens and rewritten when it ends, so a trace opened
while the agent is still working reads the same way as one opened afterwards.

The left pane lists the conversation's runs in the order they happened, folded,
with the newest at the bottom — where the transcript puts it too — and opens
scrolled to it. A folded run is one line: the prompt it answered, its status,
when it started, how long it took, how many steps it has, and what it spent.
Opening one draws its call graph — the turn, the model rounds it made, the tool
calls each round asked for nested under that round, a team member's own run as
its own branch, and the compactions, which produce no assistant text and are
therefore invisible in the transcript. The connectors are load bearing: four
levels down, indentation alone stops saying which parent a row belongs to. Every branch folds on its own, and
**Expand all** / **Collapse all** work on the run list.

That nesting is the VIEW's, not the loop's. The loop hangs every tool call off
the turn, beside the round that asked for it, because a call outlives the round
— true of the lifetimes, and unreadable: a turn with thirty flat rows says
nothing about which round caused which call. So `web/src/ui/trace/spans.ts`
re-parents each call onto the last round that started before it, and the stored
trace keeps the loop's own parent untouched.

Each row is named for the step, not for the operation: the badge already says
"TOOL" or "MODEL", so the SDK's own "execute_tool read_file" is trimmed to the
half that differs. Beside the name sits what the step acted on — the file it
read, the query it searched, the command it ran, summarised by the same code
the transcript's tool rows use — and for a model round, the reasoning effort
the call ran at, because the same model at minimal and at high is two
different requests.

Each row carries what that step cost: its duration, and fresh input, cached
input, and output tokens kept apart, because they are not billed the same and a
step that reads as expensive is often mostly cache. A step that reported no
counters — a tool call, a compaction — leaves the cell empty rather than
printing three zeroes it would be inventing. The run's own total is summed from
the model rounds alone: a turn span reports the turn's aggregate, so counting it
alongside its own rounds would bill every run twice.

**The trace also shows what the harness prepared.** Two things decide what the
model is about to read and neither is a step the loop takes: the project's
instruction files, which arrive as a context section the loop rewrites
silently, and the skill catalogue, which arrives as a tool schema. A run that
quietly read no conventions file is then indistinguishable from one that read
three — which is how "why does it ignore our rules" becomes an afternoon. So
the harness records both as `context` rows under the run: which files were
loaded (with sizes and first lines), which names it looked for, how many skills
were discovered and from which provider, and which ones the prompt named with
`/`. The candidate names are worth reading: the runtime looks for
`AGENTS.override.md` and `AGENTS.md`, so a project that keeps its conventions in
`CLAUDE.md` will show "none found" until the file is renamed or that name is
added to the section's `fileNames`.

The catalogue is scanned once per run now, rather than only for a prompt
containing a `/`: which skills a run could see is part of explaining what it
did, and it is the same directory walk the composer already does.

**A team run is coloured.** Each member takes a hue on first appearance, and its
rows carry it — the connectors, the member badge, and the chip in the run's
folded line — so a delegation reads as its own branch instead of disappearing
into the lead's. That is categorical colour, which the `--dsw-*` token set has
no scale for, so the hues are declared in `SpanTree.tsx` and are mid-lightness
on purpose: one value that works on both grounds.

Selecting a row fills the right pane. **Input + Output** is the step's own
conversation. A model round carries the request it sent, summarised rather than
copied — the tools that were on offer, how many messages the context held, and
the last eight of them clipped to 600 characters each — because a round's whole
request can be larger than the work it describes, and the tail is the part that
explains which tool it picked. Its output is the text, commentary, reasoning
and tool-call count that came back, with the tokens it spent. A tool call
carries the arguments it was given and the result it returned; a turn carries
the prompt and the final answer. **Metadata** is the raw record, every attribute
the SDK reported, for when the readable version has left out the field being
chased.

**API call** is the third tab, on a model round only. The step rows carry the
loop's capped summary of a request; this is the recording made around the
adapter call itself — the payload as sent (provider, model, effort and the other
parameters, the system prompt, the tool names on offer, and the messages) and
the stream as received (chunk count, coalesced text and reasoning, the tool
calls, the usage counters, the finish reason, or the error that ended it). It is
recorded by a `StreamMiddleware`, which the registry documents as the extension
point for request logging, so one middleware covers every provider a run may
route to — the offline one included, which is how the tests drive it.

Correlation is by request IDENTITY, not by timing: the loop's span records the
model, the message count and the id of the last message it sent, and the
recorder computes the same triple. Two members of a team streaming at once
cannot be filed under one another, which a "whichever call was in flight" rule
would do. Payloads are cut to the last 60 messages and 20k characters per block
with `truncated` set, because a conversation with a large file pasted into it is
read, not archived.

The run in flight is the exception to folding: it opens itself and streams its
steps over the same SSE connection the transcript uses, so a long run is watched
rather than waited for. A finished run is read back from SQLite when it is
opened, where `trace_spans` keeps one row per span and a deleted conversation
takes its spans with it.

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

## Not built yet

Multi-user auth and encryption of the stored
API keys (the database file is git-ignored but plaintext). Steering carries
text only: attaching a file while a run is in flight starts a new turn, because
the SDK's `inject` takes a string.

## Author

alvin0 - chaulamdinhai — [chaulamdinhai@gmail.com](mailto:chaulamdinhai@gmail.com)
