import { describe, expect, it } from 'vitest'
import { createAgentRuntime, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { defineTool as defineDistTool, experimentalNestedToolPort } from '@alvin0/ai-agent-sdk-core/agent'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { defineTool } from '../../packages/core/src/agent/tool/definition.ts'
import { ProgramResultStore } from '../../packages/core/src/agent/tool/program-results.ts'

const reader = defineTool({ name: 'read_rows', description: 'Rows.', parameters: { type: 'object' }, execute: () => ({ id: 'r1' }) })

function store(now: { value: number }, limits = {}) {
  let next = 0
  return new ProgramResultStore({ limits, now: () => now.value, newHandle: () => `h${String(++next)}` })
}

function save(target: ProgramResultStore, owner = 'program_a', value: unknown = { id: 'r1' }, definition = reader) {
  return target.save({
    owner, value: value as never, definition, schema: 'unchecked',
    provenance: { toolName: 'read_rows', callId: 'outer:1', parentCallId: 'outer' },
  })
}

describe('PTC-A12: retained program results', () => {
  const current = () => reader

  it('cannot overwrite another owner or corrupt byte accounting when a handle allocator collides', () => {
    const target = new ProgramResultStore({ newHandle: () => 'same' })
    expect(save(target, 'program_a')).toEqual({ handle: 'same' })
    const bytes = target.bytes
    expect(() => save(target, 'program_b', { secret: 'other owner' })).toThrow('collided')
    expect(target.bytes).toBe(bytes)
    expect(target.size).toBe(1)
    expect(target.load('same', 'program_a', current)).toMatchObject({ kind: 'found', value: { id: 'r1' } })
    expect(target.load('same', 'program_b', current)).toMatchObject({ kind: 'unavailable', reason: 'unknown' })
  })

  it('returns the value and host provenance to the owner only', () => {
    const now = { value: 1_000 }
    const target = store(now)
    const saved = save(target)
    expect(saved).toEqual({ handle: 'h1' })
    expect(target.load('h1', 'program_a', current)).toEqual({
      kind: 'found', value: { id: 'r1' }, schema: 'unchecked',
      provenance: { toolName: 'read_rows', callId: 'outer:1', parentCallId: 'outer', storedAt: 1_000 },
    })
    expect(target.load('h1', 'program_b', current)).toEqual({ kind: 'unavailable', reason: 'unknown' })
    expect(target.release('h1', 'program_b')).toBe(false)
    expect(target.load('h9', 'program_a', current)).toEqual({ kind: 'unavailable', reason: 'unknown' })
  })

  it('expires, goes stale with the producing tool, and closes for good', () => {
    const now = { value: 0 }
    const target = store(now, { ttlMs: 100 })
    save(target)
    save(target)
    now.value = 100
    expect(target.load('h1', 'program_a', current)).toEqual({ kind: 'unavailable', reason: 'expired' })
    now.value = 0
    const fresh = store(now)
    save(fresh)
    const replacement = defineTool({ name: 'read_rows', description: 'New.', parameters: { type: 'object' }, execute: () => 1 })
    expect(fresh.load('h1', 'program_a', () => replacement)).toEqual({ kind: 'unavailable', reason: 'stale' })
    fresh.close()
    fresh.close()
    expect(fresh.load('h1', 'program_a', current)).toEqual({ kind: 'unavailable', reason: 'closed' })
    expect(save(fresh)).toEqual({ refused: 'closed' })
    expect(fresh.size).toBe(0)
  })

  it('enforces per-entry and aggregate caps without evicting live handles', () => {
    const now = { value: 0 }
    const target = store(now, { maxEntries: 2, maxEntryBytes: 64, maxTotalBytes: 100 })
    expect(save(target, 'program_a', { blob: 'x'.repeat(100) })).toEqual({ refused: 'entry-too-large' })
    save(target, 'program_a', { blob: 'x'.repeat(40) })
    expect(save(target, 'program_a', { blob: 'y'.repeat(50) })).toEqual({ refused: 'store-full' })
    save(target)
    expect(save(target)).toEqual({ refused: 'store-full' })
    expect(target.load('h1', 'program_a', current).kind).toBe('found')
    expect(target.release('h1', 'program_a')).toBe(true)
    expect(save(target)).toMatchObject({ handle: expect.any(String) })
  })
})

describe('PTC-A12 through AgentRuntime', () => {
  it('a later program in the same turn reads a retained value; the next turn cannot', async () => {
    let rounds = 0
    class TwoPrograms extends ModelAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model, context: { contextWindow: 32_000 } }
      }
      override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        rounds++
        if (rounds === 1 || rounds === 2 || rounds === 4) {
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`p${String(rounds)}`), name: 'run_program', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const plugin = defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'x', setup(registrar) { registrar.registerAdapter(new TwoPrograms()) } })
    const runtime = await createAgentRuntime({ providers: [plugin] })
    let handle = ''
    const loads: unknown[] = []
    let reads = 0
    try {
      const program = defineDistTool({
        name: 'run_program', description: 'Program.', parameters: { type: 'object' },
        async execute(_args, context) {
          const port = experimentalNestedToolPort(context)!
          if (handle === '') {
            const first = await port.call('read_rows', {}, { retain: true })
            handle = first.ok && first.handle !== undefined ? first.handle : 'none'
            return 'stored'
          }
          const loaded = port.load(handle)
          loads.push(loaded)
          return loaded.ok ? 'loaded' : loaded.code
        },
      })
      const rows = defineDistTool({ name: 'read_rows', description: 'Rows.', parameters: { type: 'object' }, execute: () => { reads++; return { id: 'r1' } } })
      const agent = runtime.agent({ id: 'a', instructions: 'x', model: { provider: 'fixture', id: 'scripted' }, tools: [program, rows], maxTurns: 8, compaction: false })
      const session = agent.createSession({ experimentalPrograms: [{ tool: 'run_program', allow: ['read_rows'], maxCalls: 5 }] })
      await session.run('first turn')
      await session.run('second turn')
    } finally { await runtime.close() }
    expect(handle).toMatch(/^ph_/)
    expect(reads).toBe(1)
    expect(loads[0]).toMatchObject({ ok: true, value: { id: 'r1' }, provenance: { toolName: 'read_rows', parentCallId: 'p1' } })
    expect(loads[1]).toMatchObject({ ok: false, code: 'PROGRAM_RESULT_UNAVAILABLE' })
  })
})
