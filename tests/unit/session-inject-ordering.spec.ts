import { describe, expect, it } from 'vitest'
import { ModelAdapter, ModelRegistry, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { defineAgent, defineTool, type AgentSessionSnapshot } from '@alvin0/ai-agent-sdk-core/agent'

/**
 * Live finding (chat-agents S10): a steer that arrives while a model round is
 * streaming was appended ahead of that round's output. The next round then saw
 * "steer, then the work that ignored it" and treated the steer as handled.
 */
describe('AgentSession.inject during a run', () => {
  it('retains queued input in an active snapshot and resumes it without delivering it early', async () => {
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    let captured: AgentSessionSnapshot | undefined
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(): AsyncIterable<StreamChunk> {
        session.inject('QUEUED INPUT')
        captured = session.snapshot()
        expect(session.history.messages().some(message => message.content.some(block => block.type === 'text' && block.text === 'QUEUED INPUT'))).toBe(false)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    const agent = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 2 })
    session = agent.createSession({ registry })
    await session.run('start')
    const resumed = agent.resumeSession({ registry, snapshot: JSON.parse(JSON.stringify(captured)) })
    expect(resumed.history.messages().at(-1)?.content).toEqual([{ type: 'text', text: 'QUEUED INPUT' }])
    expect(session.history.messages().at(-1)?.content).toEqual([{ type: 'text', text: 'QUEUED INPUT' }])
  })

  it('rejects an oversized mid-round input at admission rather than breaking later delivery', async () => {
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(): AsyncIterable<StreamChunk> {
        expect(() => session.inject('x'.repeat(4_096))).toThrow(/byte limit/)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 2 }).createSession({
      registry, historyLimits: { maxEntryBytes: 1_024, maxBytes: 16_384 },
    })
    await session.run('start')
    expect(session.isRunning).toBe(false)
    expect(session.history.messages()).toHaveLength(2)
  })

  it('releases the session and preserves the entire queue when history cannot fit delivery', async () => {
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(): AsyncIterable<StreamChunk> {
        session.inject('QUEUED ONE')
        session.inject('QUEUED TWO')
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 2 }).createSession({
      registry, historyLimits: { maxEntries: 3 },
    })
    await expect(session.run('start')).rejects.toThrow(/entry limit/)
    await session.whenIdle()
    expect(session.isRunning).toBe(false)
    const texts = session.snapshot().history.entries.flatMap(entry => entry.event.kind === 'user'
      ? entry.event.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    expect(texts.slice(-2)).toEqual(['QUEUED ONE', 'QUEUED TWO'])
    session.reset()
    expect(session.snapshot().history.entries).toHaveLength(0)
  })
  it('includes injections from an awaited beforeStep hook in the current model request', async () => {
    const requests: string[][] = []
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    const session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 2 }).createSession({
      registry,
      hooks: { async beforeStep() {
        await Promise.resolve()
        session.inject('HOOK MESSAGE')
        return { kind: 'proceed' }
      } },
    })
    await session.run('start')
    expect(requests[0]?.at(-1)).toBe('HOOK MESSAGE')
  })

  it('queues input arriving during the checkpoint of an already-built request', async () => {
    const requests: string[][] = []
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'already requested' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    const session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 2 }).createSession({
      registry, hooks: { async checkpoint(context) {
        if (context.kind === 'before-model-request') {
          await Promise.resolve()
          session.inject('CHECKPOINT INPUT')
        }
      } },
    })
    await session.run('start')
    expect(requests[0]).not.toContain('CHECKPOINT INPUT')
    expect(session.history.messages().slice(-2).map(message => message.role)).toEqual(['assistant', 'user'])
    expect(session.history.messages().at(-1)?.content).toEqual([{ type: 'text', text: 'CHECKPOINT INPUT' }])
  })
  it('delivers a mid-round message after the output of the round that could not see it', async () => {
    const requests: string[][] = []
    let injectDuringRound: (() => void) | undefined
    let round = 0
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        try { requests.push(options.messages.map(message => `${message.role}:${message.content.map(block => block.type === 'text' ? block.text : block.type).join('|')}`)) } catch (error) { console.error('FIXTURE', error) ; throw error }
        round++
        if (round === 1) {
          // The user steers while this round is still streaming.
          try { injectDuringRound?.() } catch (error) { console.error('INJECT', error); throw error }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'write', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    // The same path chat-agents uses: defineAgent + AgentSession, steered with inject.
    const session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 4,
      tools: [defineTool({ name: 'write', description: 'w', parameters: { type: 'object' }, execute: () => 'written' })] })
      .createSession({ registry })
    injectDuringRound = () => { session.inject('STEER: use words') }
    await session.run('start')
    const entries = session.history.entries()
    const labels = entries.map(entry => entry.event.kind === 'user'
      ? `user:${entry.event.message.content.map(block => block.type === 'text' ? block.text : '').join('')}` : entry.event.kind)
    // The steer follows the tool call and its result, i.e. what round 1 produced.
    expect(labels.indexOf('user:STEER: use words')).toBeGreaterThan(labels.indexOf('tool-result'))
    // And the second request, built after delivery, carries it last.
    expect(requests[1]?.at(-1)).toBe('user:STEER: use words')
  })

  it('still appends at once when no run is active', () => {
    const registry = new ModelRegistry()
    const session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 2 }).createSession({ registry })
    expect(session.inject('hello')).toBe(1)
    expect(session.history.entries()).toHaveLength(1)
  })
})
