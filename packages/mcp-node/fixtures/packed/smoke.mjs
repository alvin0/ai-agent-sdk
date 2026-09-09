import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { dispatchToolCall } from '@alvin0/ai-agent-sdk-core/tools'
import { connectMcpStdio } from '@alvin0/ai-agent-sdk-mcp-node'

const connection = await connectMcpStdio({
  serverName: 'packed-node', command: process.execPath, args: ['server.mjs'], reconnect: false,
})
try {
  if (connection.kind !== 'tool-source' || connection.apiVersion !== 1) {
    throw new Error('stdio client is not a versioned ToolSource')
  }
  if (!connection.tools.names().includes('mcp__packed-node__add')) throw new Error('stdio catalog failed')
  const result = await dispatchToolCall({
    catalog: connection.tools,
    call: {
      callId: ToolCallId('packed-node-call'), toolName: 'mcp__packed-node__add',
      rawArguments: '{"left":20,"right":22}',
    },
    position: { turn: 1, step: 1 }, signal: new AbortController().signal,
  })
  if (result.isError || !JSON.stringify(result.value).includes('42')) {
    throw new Error(`stdio call failed: ${JSON.stringify(result)}`)
  }
} finally {
  await connection.close()
}
console.log('mcp-node-packed:pass')
