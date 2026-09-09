# Triển khai một CLI trên Node

Một agent CLI với skill từ hệ tệp, tool MCP qua stdio, phê duyệt cho các hành
động phá huỷ, và một sổ quan sát bền vững.

## Cài đặt

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/auth-node @ai-agent-sdk/provider-codex \
  @ai-agent-sdk/mcp @ai-agent-sdk/mcp-node @ai-agent-sdk/observability-node \
  @ai-agent-sdk/skill-filesystem
```

```bash
pnpm exec ai-agent-sdk-codex-login
```

## Chương trình

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
  // Không bao giờ song song: một lệnh có thể đổi trạng thái mà lệnh khác đang đọc.
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
    model: { provider: 'codex' },       // danh mục khám phá từ tài khoản
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

// Sau một cú sập, khôi phục những gì sổ đã ghi được:
const recovered = await recoverRuntimeObservationJournal('./.observations')
```

## Vì sao chọn như vậy

| Lựa chọn | Lý do |
| --- | --- |
| `codexNodeProviderPlugin()` | Kho token cục bộ theo dự án, cô lập khỏi Codex CLI thật của bạn. |
| `model: { provider: 'codex' }` | Danh mục được khám phá từ gói dịch vụ của tài khoản. |
| `mode: 'deep'` | Agent phải qua bài tự kiểm `submit_result` trước khi trả lời. |
| `isConcurrencySafe: () => false` | Một lệnh shell có thể đổi trạng thái mà lệnh khác đang đọc. |
| `skills: [fileSystemSkillProviderPlugin(...)]` | Năm mươi năng lực sẵn sàng, không cái nào vào ngữ cảnh cho tới khi được chọn. |
| `boundary: 'local-durable'` + `requirement: 'required'` | Dấu vết kiểm toán của một phiên lập trình phải sống sót qua cú sập. |
| `close()` rồi `closeWithReport()` | Làm lắng các lượt chạy trước, rồi mới đóng thứ bạn đã kết nối. |

## Thêm skill

```text
.agents/skills/release-review/
├── SKILL.md               # YAML front matter: name + description
├── agents/openai.yaml     # allow_implicit_invocation: false để ẩn khỏi model
├── references/checklist.md
└── scripts/verify.ts
```

Danh mục được khám phá lại ở đầu mỗi lượt, nên bạn có thể thêm một thư mục giữa
phiên mà không cần khởi động lại CLI.

## Đọc tiếp

- [Production Deployment](/vi/10-advanced/production-deployment) — checklist dùng chung
- [Skills](/vi/04-skills/) · [MCP](/vi/07-mcp/) · [Human Approval](/vi/06-workflows/human-approval)
