import { ToolRegistry, defineTool } from '@ai-agent-sdk/agent'
import { serveSdkMcpStdio } from '@ai-agent-sdk/mcp-node'

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
serveSdkMcpStdio({ name: 'packed-node', version: '1.0.0', tools })
