import { ToolRegistry, defineTool } from '@alvin0/ai-agent-sdk-core/tools'
import { createMcpServer, serveMcpStdio } from '@alvin0/ai-agent-sdk-mcp-node-server'

const tools = new ToolRegistry()
tools.register(defineTool({
  name: 'add', description: 'Add two numbers.',
  parameters: {
    type: 'object',
    properties: { left: { type: 'number' }, right: { type: 'number' } },
    required: ['left', 'right'], additionalProperties: false,
  },
  parse: value => value,
  execute: ({ left, right }) => ({ sum: left + right }),
}))

const server = createMcpServer({ id: 'packed-node-server', tools })
const handle = serveMcpStdio(server, { closeTimeoutMs: 2_000 })
let closing
async function close() {
  closing ??= handle.close().then(report => {
    process.stderr.write(`MCP_CLOSE_REPORT ${JSON.stringify(report)}\n`)
    if (report.deadlineReached || report.unsettledRequests !== 0 || report.error !== undefined) {
      process.exitCode = 1
    }
  })
  await closing
}
process.once('SIGTERM', () => { void close() })
process.stdin.once('end', () => { void close() })
