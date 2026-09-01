import { ToolRegistry, defineTool } from '@ai-agent-sdk/node'
import { serveSdkMcpStdio } from '@ai-agent-sdk/node/mcp'

const tools = new ToolRegistry()
tools.register(defineTool({
  name: 'multiply', description: 'Multiply two numbers.',
  parameters: {
    type: 'object',
    properties: { left: { type: 'number' }, right: { type: 'number' } },
    required: ['left', 'right'], additionalProperties: false,
  },
  parse: value => value,
  execute: ({ left, right }) => ({ product: left * right }),
}))
serveSdkMcpStdio({ name: 'node-facade', version: '1.0.0', tools })
