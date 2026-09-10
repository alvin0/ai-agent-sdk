# edge-runtime-chat-agents

A chat web app whose entire backend runs on the Next.js **Edge Runtime**, with
[Hono](https://hono.dev) as the router and the ai-agent-sdk agent loop doing the
work. It is the `chat-agents` sample reduced to what a web-standards runtime can
actually honour, and it keeps that sample's layout and design tokens.

One package, one command, one environment variable.

```bash
cd samples/edge-runtime-chat-agents/web
pnpm dev                          # http://localhost:3000
```

Then paste an OpenAI key into the page: the key button at the bottom of the
sidebar, or the **Add key** button on the banner. The same dialog is where you
add models. That is the whole setup.

To give the deployment a key of its own instead, copy `.env.example` to
`.env.local` and fill in `OPENAI_API_KEY`. The repository's root `.env` is read
too, so a key already there needs no second copy.

## Where the key comes from

Two sources, and the browser's wins when both exist.

- **Typed into the page.** Stored in `localStorage` and sent on a request
  header with each run. It never reaches the server's storage or its logs.
- **The deployment's environment.** `OPENAI_API_KEY`, used when the browser
  sent none. `/api/health` reports whether one is present, which is how the page
  knows not to ask.

A key in `localStorage` is readable by any script on this origin, and it travels
from the browser on every run. That is the right trade for a sample someone runs
with their own key, and the wrong one for an app serving other people — there,
set `OPENAI_API_KEY` on the deployment and the page will stop asking.

Conversations are held per credential: two visitors who happen to pick the same
conversation id get separate sessions, and neither can reach the other's
history. The isolate stores a digest of the key for that, never the key.

## Choosing a model

The picker sits on the composer bar, ported from the chat-agents sample along
with its `Menu` primitive and icon set. It offers whatever this browser's model
catalog holds.

**The catalog lives in Settings**, beside the API key, and in `localStorage`
alongside it. Adding a model asks for its id, its context window, and its output
cap — the SDK needs both numbers to keep a request inside what the model can
actually hold, and without them the provider adapter's defaults apply and
silently overshoot. A `gpt-4o` run with no catalog entry asks for 32,000 output
tokens; with one it asks for 16,384, which is the real cap.

The two numbers are pre-filled from a built-in table, so a known model costs one
field rather than three. The table uses OpenAI's published GPT-5 and GPT-4
limits; an unlisted `gpt-5.*` borrows the family's numbers as a starting point,
which is a suggestion to correct rather than an assertion. Anything else
pre-fills empty and runs on the adapter's defaults until someone types the real
values.

The catalog rides along with each run, because the server has no store to keep
one in. Correcting a capacity rebuilds the session: capacities are baked into
the provider when the runtime is built, not applied per request.

`EDGE_CHAT_MODELS` still seeds an empty catalog on a first visit.

Reasoning effort is in the same menu and defaults to **model default**, which
sends no effort field. The menu then shows the levels for the selected model:
GPT-5 offers `minimal` through `high`, GPT-5.1 offers `none` through `high`, and
GPT-5.2/GPT-5.4 also offer `xhigh`. Non-reasoning models such as GPT-4o and
GPT-4.1 show no levels. Picking a level adds the complete reasoning capability
list to that model's catalog entry, since the SDK validates the selected effort
against the model's declared capabilities.

Changing either replaces the session, and the model-side history goes with the
old one. That is the honest outcome — the history belongs to the model that
produced it — and the menu says so while a conversation is in progress.

## One agent, a fixed team, or Team Auto

The mode chip beside the model chip switches between a single agent and a team.
A team is `runtime.team` from the SDK: the lead receives your message and the
members get four tools for working together — `list_agents`, `send_message`,
`followup_task`, and `wait_agents`. Delegation is the model's decision, not the
host's.

**Team · auto** starts with one lead and no fixed peers. The lead receives
`spawn_agent` and creates bounded `researcher`, `analyst`, or `reviewer`
workers only when the question benefits from them. Workers inherit the selected
model and effort, start from a fork of the lead's conversation, and report back
before the lead synthesizes the final answer. Simple questions can still be
answered by the lead without creating a worker.

The managed team belongs to the warm conversation rather than one request. Its
workers are released after every settled turn so the next question can form a
fresh roster without exhausting the Edge worker cap. Cancelling the response
cancels the active lead turn and closes its current workers.

**Edit roster** opens the editor. Each member gets a name, a role, its own model
and effort, and its own instructions; a member that names no model runs the
conversation's. Two to four members, exactly one lead. Everything is validated
again on the server, since a roster becomes agent instructions and a member name
is something the model types back when it delegates.

**How a team streams.** The lead's tokens stream live, because this host owns
that run. A peer's run is started by the team rather than by the host, so none
of it is on the handle being streamed: its text is read from that member's own
session once its run ends and arrives as one block. The roster strip above the
composer shows who is working meanwhile, and clicking a member filters the
transcript to them, keeping the lead's output for context.

A team turn is several model calls in one request, so it eats far more of the
platform's per-request budget than a single agent. That budget is where a team
run on the Edge will fail first.

The roster and the mode live in `localStorage` with the model choice. Changing
either replaces the team on the server, and the conversation's history goes with
the team that produced it.

## When a run fails

The SDK redacts error text on its way into the run report, so every failure
reads "Provider operation failed" there. The report is built to be safe to
persist and ship, and a provider's error body is known to be neither — a good
default, and the wrong outcome for a page whose job is to tell one developer why
their run failed.

So the host reads the failed response itself, in the one place it owns: the
`fetch` it hands the provider. The error card shows the provider's own words,
with the SDK's code, the HTTP status, and the failing stage underneath. A wrong
model id reads as "The model `…` does not exist or you do not have access to
it", which is a sentence someone can act on.

## What is different from `chat-agents`

`chat-agents` is a desktop-shaped app: SQLite, Drizzle migrations, a workspace
sandbox, shell and filesystem tools, MCP servers and approvals. The Edge sample
keeps the useful request-trace part, but stores it in the warm isolate instead
of SQLite. A cold start clears it along with model-side conversation history.

| | `chat-agents` | this sample |
| --- | --- | --- |
| API route runtime | `nodejs` | `edge` |
| Backend | separate package, Hono | `src/server`, Hono |
| Conversation history and traces | SQLite, durable | isolate memory, lost on a cold start |
| Transcript in the browser | IndexedDB | `localStorage` |
| Tools | shell, filesystem, MCP | clock, one bounded HTTPS fetch |
| Markdown | micromark + mdast + KaTeX + Shiki | ~200 lines, no dependencies |
| Providers | OpenAI, Anthropic, Gemini, Codex | OpenAI |
| Multi-agent | teams, dynamic teams, deep mode | fixed team and Team Auto |
| Request trace | SQLite-backed span tree | in-memory span tree, streamed over SSE |

The layout is deliberately the same one: the sidebar, the conversation column,
the composer, and the `--dsw-*` token sheets are carried over, minus the
projects section and the details track, which name things an Edge deployment
does not have.

## Layout of the code

```
web/
  src/server/          the whole backend; web standards only, no node: imports
    app.ts             the Hono app: health, chat (SSE), traces and close
    sessions.ts        warm agent sessions and their trace stores
    traces.ts          span lifecycle, summaries and the in-memory trace store
    config.ts          everything read from the environment
    tools.ts           current_time and fetch_url
    wire.ts            the event protocol and the model table, shared with the page
    polyfill.ts        two repairs to the local Edge sandbox — see below
  src/app/             the Next.js app router
  src/ui/              the chat surface
    TraceDialog.tsx    run list, span tree and input/output details
    useTraces.ts       live SSE spans plus warm-session trace APIs
  src/ui/primitives/   Menu, StateDot and the icon set, from chat-agents
  src/styles/          design tokens copied from the chat-agents sample
```

`src/server` imports nothing Node-specific, so the same modules run unchanged on
Cloudflare Workers or Deno with a different entry file.

## History lives in the isolate

An Edge isolate has no disk and no database. A conversation's model-side history
lives in the isolate's memory for as long as the platform keeps that isolate
alive, and a cold start begins the conversation again — the browser still shows
the transcript, but the model no longer remembers it.

That is the honest trade for a sample that deploys with one environment
variable. For real durability, write the history to a store the host owns
(Vercel KV, Cloudflare Durable Objects, any HTTP-reachable database) and rebuild
the session from it.

The isolate holds at most `EDGE_CHAT_MAX_SESSIONS` conversations and drops any
that have been idle for `EDGE_CHAT_SESSION_TTL_MS`.

## The two sandbox repairs

`src/server/polyfill.ts` fixes two defects in the VM that `next dev` and
`next start` run Edge routes inside. Both are gated on detecting the actual
defect, so a real Edge platform gets neither.

- **`AbortSignal.any` is missing.** The SDK composes every deadline and
  cancellation out of it, so without this nothing runs locally at all.
- **`structuredClone` returns objects from the host realm.** The SDK clones tool
  schemas on the way to the provider and then checks that what it is about to
  send is a plain object. A clone from another realm fails that check, and every
  run dies with `HTTP_WIRE_BODY_INVALID` before a request is sent.

Next 16 prints a deprecation warning for `runtime = 'edge'`. The warning is
about Next's own direction, not about this code; switching the route to
`nodejs` is a one-word change if that is what you want.

## Configuration

Nothing is required: without `OPENAI_API_KEY` the page asks the visitor for one.
Everything else has a default in `src/server/config.ts`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Used when the browser sent no key. |
| `EDGE_CHAT_MODEL` | `gpt-5.4` | Model used when the page picks none. |
| `EDGE_CHAT_MODELS` | a short list | Comma-separated ids that seed a new browser catalog. |
| `EDGE_CHAT_EFFORT` | — | Reasoning level used when the page picks none. |
| `EDGE_CHAT_MODE` | `single` | Set to `team` or `team-auto` for a multi-agent default. |
| `OPENAI_BASE_URL` | OpenAI | Point at an OpenAI-compatible gateway. HTTPS only. |
| `EDGE_CHAT_INSTRUCTIONS` | a short default | System instructions. |
| `EDGE_CHAT_MAX_TURNS` | 12 | Model rounds per run. |
| `EDGE_CHAT_MAX_TOOL_CALLS` | 16 | Tool calls per run. |
| `EDGE_CHAT_MAX_TOTAL_TOKENS` | 200000 | Token ceiling per run. |
| `EDGE_CHAT_AUTO_MAX_WORKERS` | 3 | Most generated Team Auto workers active at once. |
| `EDGE_CHAT_AUTO_WORKER_TIMEOUT_MS` | 90000 | End-to-end deadline for one generated worker. |
| `EDGE_CHAT_MAX_SESSIONS` | 24 | Conversations one isolate holds. |
| `EDGE_CHAT_SESSION_TTL_MS` | 1200000 | Idle time before a session is dropped. |

An out-of-range value falls back to the default rather than failing the request.

## The wire protocol

`POST /api/chat` takes `{ conversationId, message }` and answers with
Server-Sent Events. Every frame is a `WireEvent` from `src/server/wire.ts`:
`start`, `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`,
`native-tool`, repeated `span` lifecycle frames, then exactly one `done` or
`error`. The Trace button opens the live span tree while a run is in flight.

`GET /api/conversations/:id/traces` lists recent run summaries and
`GET /api/traces/:runId` returns the spans for one run. Both are scoped to the
same credential as the chat session and only retain data while its Edge
isolate is warm.

Cancelling is cancelling the response body. The browser aborts its `fetch`, the
stream's `cancel` runs, and the run is aborted — there is no cancel endpoint,
because the request would not reach the isolate holding the run anyway.

Both `POST` routes accept an `x-openai-key` header carrying the visitor's key.
A header, not a body field, so the key stays out of anything that logs or
replays a request payload.

`GET /api/health` reports the model, whether the deployment holds a key of its
own, and how many conversations this isolate holds. `POST /api/close` drops one
conversation — it needs the same key that opened it, since that is what
identifies whose session it is.

## Deploying

Vercel needs the project root set to `samples/edge-runtime-chat-agents/web`.
Nothing else is required: the route already declares `runtime = 'edge'`, and
visitors can supply their own key. Set `OPENAI_API_KEY` in the environment if
the deployment should pay instead.
