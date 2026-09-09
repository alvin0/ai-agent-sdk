import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ModelAdapter,
  createAgentRuntime,
  type GenerateOptions,
  type ModelInvocationContext,
  type ModelProviderRegistrar,
  type ResolvedModelInfo,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import type { ComposableModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { jsonlObservationExporter } from '@alvin0/ai-agent-sdk-observability-node'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()))) throw new Error(`refusing to remove ${absolute}`)
    await rm(absolute, { recursive: true, force: true })
  }
})

class JournalAdapter extends ModelAdapter {
  async * stream(_options: GenerateOptions, _context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'private response content' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'private response content' } }
    yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id, name: id })
  }
}

function provider(): ComposableModelProviderPlugin {
  const adapter = new JournalAdapter()
  return {
    kind: 'model-provider-plugin',
    apiVersion: 1,
    id: 'journal-provider',
    displayName: 'Journal provider',
    family: 'fixture',
    routes: ['fixture-journal'],
    defaultModel: { provider: 'fixture-journal', id: 'fixture-model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['fixture-journal'], adapter) },
  }
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ai-agent-sdk-runtime-journal-${label}-`))
  roots.push(root)
  return join(root, 'observations')
}

async function frames(root: string): Promise<Array<Record<string, unknown>>> {
  const directory = join(root, 'runtime-delivery')
  const names = (await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort()
  const output: Array<Record<string, unknown>> = []
  for (const name of names) {
    const text = await readFile(join(directory, name), 'utf8')
    for (const line of text.trim().split('\n')) if (line.length > 0) output.push(JSON.parse(line))
  }
  return output
}

describe('recommended Node JSONL observation exporter', () => {
  it('is inert until runtime readiness and durably journals events plus the terminal usage record', async () => {
    const root = await temporaryRoot('runtime')
    const exporter = jsonlObservationExporter({ rootDir: root, mode: 'reliable' })
    expect(exporter).toMatchObject({ kind: 'observation-exporter', apiVersion: 1, id: 'journal' })
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' })

    const runtime = await createAgentRuntime({
      providers: [provider()],
      observability: {
        mode: 'reliable',
        exporters: [{
          exporter,
          ownership: 'owned',
          requirement: 'required',
          boundary: 'local-durable',
        }],
      },
    })
    const response = await runtime.agent({
      id: 'journal-agent', instructions: 'Return a fixture answer.', compaction: false,
    }).generate('private user content')
    expect(response.report).toMatchObject({
      status: 'success',
      usage: { reported: { inputTokens: 11, outputTokens: 3, totalTokens: 14 }, authoritative: true },
      delivery: { complete: true, reachedBoundary: 'local-durable' },
    })
    await runtime.close()

    const saved = await frames(root)
    expect(saved.some(frame => frame.itemKind === 'event')).toBe(true)
    expect(saved.filter(frame => frame.itemKind === 'run-terminal-record')).toHaveLength(1)
    const terminal = JSON.parse(String(saved.find(frame => frame.itemKind === 'run-terminal-record')?.payloadJson))
    expect(terminal).toMatchObject({
      kind: 'run-terminal-record', runId: response.runId,
      usage: { reported: { totalTokens: 14 }, authoritative: true },
    })
    expect(terminal).not.toHaveProperty('delivery')
    expect(JSON.stringify(saved)).not.toContain('private user content')
    expect(JSON.stringify(saved)).not.toContain('private response content')

    const reopened = jsonlObservationExporter({ rootDir: root, mode: 'reliable' })
    const signal = new AbortController().signal
    await expect(reopened.ready?.(signal)).resolves.toBeUndefined()
    await expect(reopened.shutdown?.(signal)).resolves.toBeUndefined()
  })

  it('honors pre-abort before filesystem acquisition and rejects use before readiness', async () => {
    const root = await temporaryRoot('abort')
    const exporter = jsonlObservationExporter({ rootDir: root, mode: 'audit' })
    const controller = new AbortController()
    controller.abort(new Error('cancelled before readiness'))
    await expect(exporter.ready?.(controller.signal)).rejects.toThrow('cancelled before readiness')
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => exporter.stage?.({} as never)).toThrow(/not ready/i)
  })
})
