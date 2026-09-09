# Deploying a Node CLI

A CLI agent with filesystem skills, MCP stdio tools, approvals for destructive
actions, and a durable observation journal.

## Install

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/auth-node @ai-agent-sdk/provider-codex \
  @ai-agent-sdk/mcp @ai-agent-sdk/mcp-node @ai-agent-sdk/observability-node \
  @ai-agent-sdk/skill-filesystem
```

```bash
pnpm exec ai-agent-sdk-codex-login
```

## The program

```ts
import { createInterface } from 'node:readline/promises'
import { createAgentRuntime, createApprovalBroker, defineTool } from '@ai-agent-sdk/core'
import { codexNodeProviderPlugin } from '@ai-agent-sdk/auth-node/codex'
import { connectMcpStdio } from '@ai-agent-sdk/mcp-node'
import {
  jsonlObservationExporter,
  recoverRuntimeObservationJournal,
} from '@ai-agent-sdk/observability-node'
import { fileSystemSkillProviderPlugin } from '@ai-agent-sdk/skill-filesystem'

const runShellCommand = defineTool({
  name: 'run_command',
  description: 'Run a shell command in the project directory.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  parse: raw => raw as { command: string },
  execute: async ({ command }, ctx) => {
    const { stdout, stderr, code } = await exec(command, { signal: ctx.signal })
    return { code, stdout, stderr }
  },
  // Never parallel: a command can change state another command reads.
  isConcurrencySafe: () => false,
  timeoutMs: 120_000,
})

const runtime = await createAgentRuntime({
  providers: [codexNodeProviderPlugin()],
  resource: { serviceName: 'coding-cli', runtime: 'node' },
  observability: {
    mode: 'reliable',
    exporters: [{
      exporter: jsonlObservationExporter({
        rootDir: './.observations',
        mode: 'reliable',
      }),
      ownership: 'owned',
      requirement: 'required',
      boundary: 'local-durable',
    }],
  },
  closeTimeoutMs: 30_000,
})

let mcp: Awaited<ReturnType<typeof connectMcpStdio>> | undefined

try {
  mcp = await connectMcpStdio({
    serverName: 'filesystem',
    command: process.execPath,
    args: ['./node_modules/.bin/mcp-filesystem-server', process.cwd()],
    logger: runtime.logger({ fields: { integration: 'mcp-stdio' } }),
  })

  const approvals = createApprovalBroker()
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  const agent = runtime.agent({
    id: 'coding-cli',
    name: 'Coding assistant',
    instructions: [
      'Work in the current project.',
      'Load a relevant skill before using it.',
      'Verify every change before reporting success.',
    ].join(' '),
    model: { provider: 'codex' },       // account-discovered catalog
    mode: 'deep',
    tools: [runShellCommand],
    toolSources: [mcp],
    skills: [fileSystemSkillProviderPlugin({ cwd: process.cwd() })],
    commentary: 'concise',
    maxTurns: 24,
    maxToolCalls: 96,
  })

  const session = agent.createSession({
    approvals,
    skillCwd: process.cwd(),
    runtimeLimits: {
      maxTotalTokens: 400_000,
      maxToolDurationMs: 180_000,
      toolTeardownTimeoutMs: 15_000,
    },
  })

  for (;;) {
    const input = await rl.question('> ')
    if (input.trim() === '') break

    const handle = session.stream(input)

    for await (const event of handle) {
      switch (event.type) {
        case 'commentary-delta':
        case 'assistant-delta':
          process.stdout.write(event.text)
          break
        case 'tool-call':
          console.log(`\n  → ${event.name}`)
          break
        case 'tool-result':
          console.log(`  ← ${event.name} (${event.status})`)
          break
        case 'approval-request': {
          const answer = await rl.question(
            `\nApprove ${event.request.toolName}? [y/N] `,
          )
          approvals.resolve(event.request.requestId, {
            decision: answer.toLowerCase() === 'y' ? 'approve' : 'reject',
          })
          break
        }
        case 'usage':
          console.log(`\n  [${JSON.stringify(event.usage)}]`)
          break
      }
    }

    await handle.result
  }

  rl.close()
} finally {
  try {
    const report = await runtime.close()
    if (report.unsettledRuns > 0) {
      console.error(`WARNING: ${report.unsettledRuns} runs ignored cancellation`)
    }
  } finally {
    await mcp?.closeWithReport()
  }
}

// After a crash, recover what the journal captured:
const recovered = await recoverRuntimeObservationJournal('./.observations')
```

## Why each choice

| Choice | Reason |
| --- | --- |
| `codexNodeProviderPlugin()` | Project-local token store, isolated from your real Codex CLI. |
| `model: { provider: 'codex' }` | The catalog is discovered from the account's plan. |
| `mode: 'deep'` | The agent must pass its `submit_result` self-check before answering. |
| `isConcurrencySafe: () => false` | A shell command can change state another command reads. |
| `skills: [fileSystemSkillProviderPlugin(...)]` | Fifty capabilities available, none in context until selected. |
| `boundary: 'local-durable'` + `requirement: 'required'` | A coding session's audit trail must survive a crash. |
| `close()` then `closeWithReport()` | Quiesce runs first, then close what you connected. |

## Adding skills

```text
.agents/skills/release-review/
├── SKILL.md               # YAML front matter: name + description
├── agents/openai.yaml     # allow_implicit_invocation: false to hide from the model
├── references/checklist.md
└── scripts/verify.ts
```

The catalog is rediscovered at the start of each turn, so you can add a folder
mid-session without restarting the CLI.

## Read next

- [Production Deployment](/en/10-advanced/production-deployment) — the shared checklist
- [Skills](/en/04-skills/) · [MCP](/en/07-mcp/) · [Human Approval](/en/06-workflows/human-approval)
