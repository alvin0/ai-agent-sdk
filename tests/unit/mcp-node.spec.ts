import { describe, expect, it } from 'vitest'
import {
  connectMcpStdio,
  createMcpStdioClient,
  hostHeaderValidation,
  serveSdkMcpStdio,
  toNodeHandler,
} from '@ai-agent-sdk/mcp-node'

describe('MCP Node capability', () => {
  it('exposes stdio and Node HTTP boundaries without hiding process creation', () => {
    expect(() => createMcpStdioClient({ command: '  ', serverName: 'empty' })).toThrow(/must not be empty/)
    expect(connectMcpStdio).toBeTypeOf('function')
    expect(serveSdkMcpStdio).toBeTypeOf('function')
    expect(toNodeHandler).toBeTypeOf('function')
    expect(hostHeaderValidation).toBeTypeOf('function')
  })
})
