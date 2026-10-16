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

- Delegation: the lead calls `spawn_agent` twice; generated workers inherit `read_note`,
  return findings, and the lead joins with `wait_agents` before synthesizing.
- Collaboration: the lead first creates shared tasks. Workers read, claim with the
  current revision and complete their tasks with evidence. After joining, the lead
  reads the shared results through `task_list({ ids })` and synthesizes one answer.

Expected answer in both modes:

```text
Cache rollout: median latency halved (80 ms → 40 ms); error rate stayed at 1%.
```

Output includes two completed workers; collaboration also includes two completed
tasks with different owners. Invalid modes and incomplete runs exit with an error.
The helper disposes its managed team and underlying control plane in `finally`.

[`team.ts`](team.ts) is the host setup. [`adapter.ts`](adapter.ts) is a small local
fake `ModelAdapter`: it scripts model tool calls, checks that tools are offered,
reads real tool responses for board revisions, and requires evidence before answering.
The host does **not** call `team.spawn` or prepopulate the board; the SDK executes
every requested coordination tool. Scripted choices and synthetic usage are protocol
fixtures, not evidence of autonomous model quality, token savings or speed. This
example exercises board coordination; bounded peer messaging is described in the guide.

The model id `offline/scripted-team` names only this local fake. For a real provider,
register its adapter and configure `defineAgent` with your provider/model; remove
the scripted adapter. Repository live OpenAI/Codex examples use `gpt-6-luna` or a
newer explicitly selected model and never fall back to an older model.

See the [multi-agent guide](../../docs/multi-agent.md) for roles, guarded inheritance,
limits, streaming, migration and troubleshooting; the [chat sample](../chat-agents/README.md)
shows a conversation-owned streaming integration.
