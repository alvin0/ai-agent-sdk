# Offline multi-agent example

Run from the repository root with Node 22.18+ (native TypeScript stripping) and pnpm:

```sh
pnpm install --frozen-lockfile # only when dependencies are missing
pnpm --filter @alvin0/ai-agent-sdk-core build
pnpm sample:multi-agent
pnpm sample:multi-agent delegation
pnpm sample:multi-agent collaboration
```

No credentials, environment file, provider service or network connection is used.
The sample imports the workspace core package. It needs no separate installation.

Both runs inspect two local cache rollout measurements with a host `read_note` tool:

- Plain delegation starts with `read_note` and `spawn_agent`. After a successful
  spawn, the lead also receives `send_input`, `wait_agents`, `get_agent_result` and
  `close_agent`; the first successful model spawn result includes detailed guidance
  once. The fake adapter requires those controls only after successful spawn responses.
  Collaboration and worker catalogs remain eager. Hosts that need the previous eager
  surface can set `progressiveToolDisclosure: false`.
- Delegation: the lead calls `spawn_agent` twice; generated workers inherit `read_note`,
  and the lead yields with provisional text without calling `wait_agents`. Workers
  return findings through automatic push delivery, which resumes lead synthesis.
- Collaboration: the lead first creates shared tasks. Workers read, claim with the
  current revision and complete their tasks with evidence. The latency worker sends
  one actionable `send_input` to the error worker, without an acknowledgement loop.
  After joining with `wait_agents`, the lead reads the shared results through
  `task_list({ ids })` and synthesizes one answer.

Expected answer in both modes:

```text
Cache rollout: median latency halved (80 ms → 40 ms); error rate stayed at 1%.
```

Output includes two completed workers; collaboration also includes two completed
tasks with different owners. `yieldedTurns` counts provisional lead yields; delegation
must yield before worker evidence is released. Invalid modes and incomplete runs exit
with an error.
The helper disposes its managed team and underlying control plane in `finally`.

[`team.ts`](team.ts) is the host setup. [`adapter.ts`](adapter.ts) is a small local
fake `ModelAdapter`: it scripts model tool calls, checks that tools are offered,
reads real tool responses for board revisions, and requires evidence before answering.
The host does **not** call `team.spawn` or prepopulate the board; the SDK executes
every requested coordination tool. Promise gates keep delegation results pending until
the host observes a real provisional yield, and keep the peer recipient live until
the send is accepted. These gates use no timers. Scripted choices and synthetic usage
are protocol fixtures, not evidence of autonomous model quality, token savings or speed. This
example exercises both board coordination and one peer message; core tests cover
peer-credit exhaustion and other scheduling races.

The model id `offline/scripted-team` names only this local fake. For a real provider,
register its adapter and configure `defineAgent` with your provider/model; remove
the scripted adapter. Repository live OpenAI/Codex examples use `gpt-6-luna` or a
newer explicitly selected model and never fall back to an older model.

See the [multi-agent guide](../../docs/multi-agent.md) for roles, guarded inheritance,
limits, streaming, migration and troubleshooting; the [chat sample](../chat-agents/README.md)
shows a conversation-owned streaming integration.
