import { InMemoryTransport, type Client } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { McpClientConnection } from '@alvin0/ai-agent-sdk-mcp/client'
import { createSdkMcpServer } from '@alvin0/ai-agent-sdk-mcp/server'
import { History } from '../../packages/core/src/agent/history/history.ts'
import { scheduleToolCalls } from '../../packages/core/src/agent/loop/schedule.ts'
import { defineTool, type ToolDefinition } from '../../packages/core/src/agent/tool/definition.ts'
import {
  nestedToolPort, NESTED_TOOL_ERROR_CODES, type NestedToolPort, type NestedToolResult,
} from '../../packages/core/src/agent/tool/nested.ts'
import { checkOutputSchema, outputSchemaSupported } from '../../packages/core/src/agent/tool/output-schema.ts'
import { ToolRegistry } from '../../packages/core/src/agent/tool/registry.ts'
import { createSpanId, createTraceId } from '../../packages/core/src/agent/trace/trace.ts'
import { ToolCallId } from '../../packages/core/src/primitives/index.ts'
import type { JsonObject, JsonValue } from '../../packages/core/src/primitives/index.ts'
import { RecordingLogger } from './fixtures/integration-logger.ts'

const ROW_SCHEMA: JsonObject = {
  type: 'object',
  properties: { id: { type: 'string' }, total: { type: 'integer', minimum: 0 } },
  required: ['id', 'total'],
}

async function runWith(
  children: readonly ToolDefinition[],
  script: (port: NestedToolPort) => Promise<JsonValue>,
  maxResultBytes?: number,
) {
  const tools = new ToolRegistry()
  const seen: NestedToolResult[] = []
  let catalog: ReturnType<NestedToolPort['catalog']> = []
  tools.register(defineTool({
    name: 'run_program', description: 'Host program.', parameters: { type: 'object' },
    async execute(_args, context) {
      const port = nestedToolPort(context)!
      catalog = port.catalog()
      return await script({ ...port, call: async (name, args) => {
        const result = await port.call(name, args); seen.push(result); return result
      } })
    },
  }))
  for (const child of children) tools.register(child)
  const outcome = await scheduleToolCalls({
    calls: [{ callId: ToolCallId('outer'), toolName: 'run_program', rawArguments: '{}' }],
    catalog: tools, history: new History(), position: { turn: 1, step: 1 },
    signal: new AbortController().signal,
    parentTrace: { traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null } as never,
    ...maxResultBytes === undefined ? {} : { maxResultBytes },
  }, { admissionLimit: 24, programs: new Map([['run_program', { allow: children.map(child => child.name), maxCalls: 10 }]]) })
  return { outcome, seen, catalog, tools }
}

function child(name: string, value: JsonValue, outputSchema?: JsonObject): ToolDefinition {
  return defineTool({
    name, description: `${name} fixture.`, parameters: { type: 'object' },
    ...outputSchema === undefined ? {} : { experimentalOutputSchema: outputSchema },
    execute: () => value,
  })
}

describe('output schema subset', () => {
  it('gives definite verdicts inside the subset and refuses to judge outside it', () => {
    expect(checkOutputSchema(ROW_SCHEMA, { id: 'a', total: 3 })).toBe('valid')
    expect(checkOutputSchema(ROW_SCHEMA, { id: 'a', total: -1 })).toBe('invalid')
    expect(checkOutputSchema(ROW_SCHEMA, { id: 'a' })).toBe('invalid')
    expect(checkOutputSchema({ type: 'array', items: { enum: ['x', 'y'] } }, ['x', 'z'])).toBe('invalid')
    expect(checkOutputSchema({ type: ['string', 'null'] }, null)).toBe('valid')
    expect(checkOutputSchema({ anyOf: [{ type: 'string' }] }, 'x')).toBe('unsupported')
    expect(checkOutputSchema({ type: 'object', properties: { a: { pattern: '^x' } } }, { a: 'x' })).toBe('unsupported')
    expect(outputSchemaSupported(ROW_SCHEMA)).toBe(true)
    // A keyword on a branch no value reaches is still outside the subset.
    expect(outputSchemaSupported({ type: 'object', properties: { a: { oneOf: [] } } })).toBe(false)
    expect(checkOutputSchema({ type: 'object', properties: { a: { oneOf: [] } } }, {})).toBe('unsupported')
    expect(checkOutputSchema({ type: 'array', items: { pattern: '^x' } }, [])).toBe('unsupported')
  })
})

describe('PTC-A10: output contracts reach programs without guessing', () => {
  it('validates declared schemas, marks missing or unsupported ones unchecked, and refuses mismatches', async () => {
    const run = await runWith([
      child('typed', { id: 'r1', total: 4 }, ROW_SCHEMA),
      child('wrong', { id: 'r1', total: 'four' }, ROW_SCHEMA),
      child('untyped', { anything: true }),
      child('exotic', { id: 'r1' }, { anyOf: [{ type: 'object' }] }),
      child('absent-exotic', {}, { type: 'object', properties: { unused: { oneOf: [{ type: 'string' }] } } }),
    ], async port => {
      for (const name of ['typed', 'wrong', 'untyped', 'exotic', 'absent-exotic']) await port.call(name, {})
      return 'done'
    })
    expect(run.seen).toEqual([
      { ok: true, value: { id: 'r1', total: 4 }, schema: 'validated' },
      expect.objectContaining({ ok: false, code: NESTED_TOOL_ERROR_CODES.OUTPUT_SCHEMA_MISMATCH }),
      { ok: true, value: { anything: true }, schema: 'unchecked' },
      { ok: true, value: { id: 'r1' }, schema: 'unchecked' },
      { ok: true, value: {}, schema: 'unchecked' },
    ])
    expect(run.catalog.map(entry => [entry.name, entry.output])).toEqual([
      ['typed', 'declared'], ['wrong', 'declared'], ['untyped', 'unknown'], ['exotic', 'unsupported'],
      ['absent-exotic', 'unsupported'],
    ])
  })

  it('an oversized child value is a resource error, never a truncated object', async () => {
    const run = await runWith([child('huge', { rows: 'x'.repeat(4096) }, ROW_SCHEMA)], async port => {
      await port.call('huge', {})
      return 'done'
    }, 2048)
    expect(run.seen[0]).toMatchObject({ ok: false, code: 'INVALID_TOOL_RESULT' })
    expect(run.seen[0]).not.toHaveProperty('value')
  })
})

describe('PTC-A15: output metadata survives capture and MCP, and stays off the provider wire', () => {
  it('capture detaches and freezes the schema and bounds its size', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } } } as Record<string, JsonValue>
    const captured = child('typed', {}, schema as JsonObject)
    ;(schema.properties as Record<string, JsonValue>).id = { type: 'number' }
    expect(captured.experimentalOutputSchema).toEqual({ type: 'object', properties: { id: { type: 'string' } } })
    expect(Object.isFrozen(captured.experimentalOutputSchema)).toBe(true)
    const deep: Record<string, JsonValue> = {}
    let cursor = deep
    for (let depth = 0; depth < 200; depth++) { const next: Record<string, JsonValue> = {}; cursor.properties = next; cursor = next }
    expect(() => child('deep', {}, deep as JsonObject)).toThrow()
  })

  it('provider schemas never carry the output schema', () => {
    const tools = new ToolRegistry()
    tools.register(child('typed', {}, ROW_SCHEMA))
    expect(JSON.stringify(tools.schemas())).not.toContain('experimentalOutputSchema')
    expect(Object.keys(tools.schemas()[0]!)).toEqual(['name', 'description', 'parameters'])
  })

  it('the MCP bridge maps outputSchema onto structuredContent and each refresh yields new definitions', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'rows', version: '1.0.0', tools: new ToolRegistry() as never })
    await server.connect(serverTransport)
    const connection = new McpClientConnection({ serverName: 'rows', reconnect: false }, () => clientTransport)
    try {
      await connection.connect()
      const generation = (connection as unknown as { current: Client }).current
      generation.listTools = vi.fn(async () => ({ tools: [
        { name: 'row', inputSchema: { type: 'object' }, outputSchema: ROW_SCHEMA },
      ] })) as typeof generation.listTools
      generation.callTool = vi.fn(async () => ({
        content: [{ type: 'text', text: 'row r9' }], structuredContent: { id: 'r9', total: 2 },
      })) as unknown as typeof generation.callTool
      await connection.refreshTools()
      const snapshot = () => connection.snapshot({ signal: new AbortController().signal, logger: new RecordingLogger() })
      const first = snapshot().tools[0]!
      expect(first.experimentalOutputSchema).toEqual({
        type: 'object', properties: { structuredContent: ROW_SCHEMA }, required: ['structuredContent'],
      })
      const run = await runWith([first as unknown as ToolDefinition], async port => (await port.call(first.name, {})) as never)
      expect(run.seen[0]).toMatchObject({ ok: true, schema: 'validated', value: { structuredContent: { id: 'r9', total: 2 } } })
      await connection.refreshTools()
      // A new catalog revision is a new definition: a program that captured
      // the old one sees it as stale instead of silently switching contracts.
      expect(snapshot().tools[0]).not.toBe(first)
    } finally {
      await connection.close()
      await server.close()
    }
  })
})

describe('output schema subset: malformed schemas', () => {
  it.each([
    { required: [7] }, { required: ['id', 'id'] }, { minLength: -1 }, { maxItems: 1.5 },
    { enum: [] }, { enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }, { type: ['string', 'string'] },
  ])('does not validate against malformed schema %j', schema => {
    expect(outputSchemaSupported(schema as JsonObject)).toBe(false)
    expect(checkOutputSchema(schema as JsonObject, {})).toBe('unsupported')
  })
  it('treats a malformed bound as an unsupported schema, never as an invalid value', () => {
    expect(checkOutputSchema({ type: 'integer', minimum: 'zero' }, 3)).toBe('unsupported')
    expect(checkOutputSchema({ type: 'string', maxLength: '3' }, 'abcdef')).toBe('unsupported')
    expect(outputSchemaSupported({ type: 'integer', minimum: 'zero' })).toBe(false)
    expect(outputSchemaSupported({ type: 'object', required: 'id' })).toBe(false)
  })
})
