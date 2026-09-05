import { Buffer } from 'node:buffer'
import { ReadBuffer as ClientReadBuffer } from '@modelcontextprotocol/client'
import { ReadBuffer as ServerReadBuffer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

describe('MCP upstream stdio runtime compatibility', () => {
  it.each([
    ['client', ClientReadBuffer],
    ['server', ServerReadBuffer],
  ] as const)('preserves Node Buffer typing and runtime parsing for %s', (_name, Reader) => {
    const reader = new Reader()
    reader.append(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'))
    expect(reader.readMessage()).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'ping' })
  })
})
