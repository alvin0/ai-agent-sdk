# chat-agents live workflows

Real model, real HTTP API, real workspace. `run.ts` drives a running `chat-agents`
sample through `/api/chat` (SSE), `/api/approve`, `/api/answer`, `/api/steer` and
`/api/abort`. It judges each scenario on workspace files or exact answers, never on
the model's claims alone.

## Start an isolated sample

Keep the default sample state untouched. Point it at a scratch database, workspace
and spill directory, and at a model you are allowed to use:

```sh
L=$TMPDIR/chat-live && mkdir -p $L/workspace
cd samples/chat-agents/web
# The key comes from the process environment; nothing is written to the database.
OPENAI_API_KEY=… CHAT_AGENTS_DB=$L/chat-agents.db CHAT_AGENTS_WORKSPACE=$L/workspace \
CHAT_AGENTS_SPILL=$L/spill CHAT_AGENTS_DIST_DIR=.next-live npx next dev -p 3310
# For an OpenAI-compatible gateway, set only its base URL:
curl -X PUT localhost:3310/api/providers/openai/credential -H 'content-type: application/json' \
  -d '{"baseUrl":"https://<gateway>/api/v1"}'
```

## Run

```sh
node --experimental-strip-types test-human/chat-agents-live/run.ts --base http://localhost:3310 \
  --workspace $TMPDIR/chat-live/workspace --provider codex --model gpt-6-luna [--only S2,S10] [--repeat 2]
```

The harness re-seeds the workspace for each repeat. Results, per-scenario event
streams and a summary go to `artifacts/chat-agents-live/<provider>-<model>-<time>/`.

| ID | Workflow |
|---|---|
| S1 | Plain Q&A |
| S2 | Read a CSV, aggregate, write `report.json` (approval allowed) |
| S3 | Write denied: no file, no false success claim |
| S4 | Large log: exact error-code counts |
| S5 | Multi-turn memory |
| S6 | Abort mid-run, then continue the conversation |
| S7 | Human-in-the-loop: ask, get an answer, act on it |
| S8 | Run a shell command and report its output |
| S9 | Fix a bug in `calc.js` and verify it by running it |
| S10 | Steer mid-run changes the output |
| S11 | team-dynamic: delegate two analyses and combine them |
| S12 | Two conversations at once stay isolated |
| S13 | Find a marker deep in a large file |
| S14 | Session-scoped approval is asked once for repeated writes |
| S15 | Abort while an approval is pending |
| S16 | Destructive delete denied keeps the file |

Findings and fixes are recorded in
[docs/evaluations/chat-agents-live-2026-09-27](../../docs/evaluations/chat-agents-live-2026-09-27/findings.md).
