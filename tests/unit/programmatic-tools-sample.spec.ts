import { existsSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createAgentRuntime, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, StreamChunk, RuntimeAgentRunEvent } from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { createProgramTool, RESEARCH_QUICKJS_ENTRY } from '../../samples/programmatic-tools/program-tool.ts'
// @ts-expect-error This guest prelude is also loaded directly by the Node workers.
import { GUEST_JSON_PRELUDE } from '../../samples/programmatic-tools/guest-json.mjs'

describe('programmatic tool sample boundaries', () => {
  it.each([
    "const a = [1]; a.extra = undefined; return a",
    "const a = [1]; a[Symbol('extra')] = 2; return a",
    "const a = [1]; Object.defineProperty(a, 'extra', { get() { throw new Error('getter invoked') } }); return a",
    "return [, 1]",
  ])('rejects array data JSON would silently discard: %s', body => {
    expect(() => runInNewContext(`${GUEST_JSON_PRELUDE}\n__encodeArguments((() => { ${body} })())`))
      .toThrow('PROGRAM_INVALID_ARGUMENTS: value must be bounded lossless JSON')
  })

  it('preserves valid dense array values', () => {
    expect(runInNewContext(`${GUEST_JSON_PRELUDE}\n__encodeArguments([null, 'a|b', 2, { x: true }])`))
      .toBe('[null,"a|b",2,{"x":true}]')
  })

  it.each([0, -1, NaN, Infinity])('rejects a wall timeout that cannot enforce its bound: %s', wallMs => {
    expect(() => createProgramTool({ quickjsEntry: RESEARCH_QUICKJS_ENTRY, limits: { wallMs } })).toThrow('wallMs')
  })

  it.skipIf(!existsSync(RESEARCH_QUICKJS_ENTRY)).each(['sync', 'async'] as const)(
    'terminates the real %s worker when diagnostic observers throw', async executor => {
      let started = 0, exited = 0, round = 0
      const outputs: unknown[] = []
      class Scripted extends ModelAdapter {
        override async resolveModel(provider: string, id: string) { return { provider, id, name: id } }
        override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
          if (++round === 1) {
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('program'), name: 'execute_program', arguments: '{"code":"return [1, 2]"}' } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          } else {
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        }
      }
      const runtime = await createAgentRuntime({ providers: [defineModelProviderPlugin({
        id: 'fixture', routes: ['fixture'], displayName: 'sample executor fixture',
        setup(registrar) { registrar.registerAdapter(new Scripted()) },
      })] })
      try {
        const tool = createProgramTool({ quickjsEntry: RESEARCH_QUICKJS_ENTRY, executor,
          observer: {
            workerStarted() { started++; throw new Error('start observer failed') },
            workerExited() { exited++; throw new Error('exit observer failed') },
          } })
        const session = runtime.agent({ id: 'program', model: { provider: 'fixture', id: 'scripted' },
          instructions: 'Use programs.', tools: [tool], maxTurns: 4, compaction: false,
        }).createSession({ experimentalPrograms: [{ tool: 'execute_program', allow: [], maxCalls: 1 }] })
        await session.run('Start.', { onEvent(event: RuntimeAgentRunEvent) {
          if (event.type === 'tool-result') outputs.push(event.output)
        } })
        expect(outputs).toContainEqual(expect.objectContaining({ isError: false, value: { result: [1, 2] } }))
        expect({ started, exited }).toEqual({ started: 1, exited: 1 })
      } finally { await runtime.close() }
    }, 10_000,
  )
})
