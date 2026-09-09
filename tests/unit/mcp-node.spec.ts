import { describe, expect, it } from 'vitest'
import {
  connectMcpStdio,
  createMcpStdioClient,
  McpConnectionError,
} from '@ai-agent-sdk/mcp-node'

describe('MCP Node capability', () => {
  it('exposes only the stdio client boundary without hiding process creation', () => {
    expect(() => createMcpStdioClient({ command: '  ', serverName: 'empty' })).toThrow(/must not be empty/)
    expect(connectMcpStdio).toBeTypeOf('function')
  })

  it('wraps stdio startup failure with one support-safe transactional cleanup report', async () => {
    const privateCommand = '/definitely-missing/PRIVATE_MCP_STDIO_COMMAND'
    let thrown: unknown
    try {
      await connectMcpStdio({
        serverName: 'missing-stdio-server',
        command: privateCommand,
        reconnect: false,
        operationTimeoutMs: 1_000,
        closeTimeoutMs: 100,
      })
    } catch (error: unknown) { thrown = error }

    expect(thrown).toBeInstanceOf(McpConnectionError)
    expect(thrown).toMatchObject({
      code: 'MCP_CONNECT_FAILED',
      cleanup: {
        state: 'closed',
        deadlineReached: false,
        unsettledOperations: 0,
      },
    })
    expect(JSON.stringify(thrown)).not.toContain(privateCommand)
    expect((thrown as Error).cause).toBeInstanceOf(Error)
  })
})
