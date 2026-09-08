import { it, expect, vi } from 'vitest'
import { defineToolFromSchema } from '../../packages/core/src/agent/tool/schema.ts'
import { dispatchToolCall } from '../../packages/core/src/agent/tool/pipeline.ts'
import { ToolRegistry } from '../../packages/core/src/agent/tool/registry.ts'
import { ToolCallId } from '../../packages/core/src/primitives/brand.ts'

it('derives validated tool arguments and the model schema from the same adapter', async () => {
  const schema = {
    jsonSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    parse(value: unknown) {
      if (typeof value !== 'object' || value === null || !('count' in value) || typeof value.count !== 'number' || !Number.isInteger(value.count)) throw new Error('integer required')
      return { count: value.count }
    },
  }
  const execute = vi.fn((args: { count: number }) => args.count + 1)
  const tool = defineToolFromSchema(schema, { name: 'count', description: 'count', execute: args => execute(args) })
  const catalog = new ToolRegistry(); catalog.register(tool)
  const run = (rawArguments: string) => dispatchToolCall({ catalog,
    call: { callId: ToolCallId('schema'), toolName: 'count', rawArguments },
    position: { turn: 1, step: 1 }, signal: new AbortController().signal,
  })
  expect(tool.parameters).toEqual(schema.jsonSchema)
  expect(await run('{"count":2}')).toMatchObject({ isError: false, value: 3 })
  expect(await run('{"count":"two"}')).toMatchObject({ isError: true, error: { code: 'INVALID_ARGUMENTS' } })
  expect(execute).toHaveBeenCalledTimes(1)
})
