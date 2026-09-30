import { describe, expect, it } from 'vitest'
import { ModelAdapter, ModelRegistry, ToolCallId, createUserMessage } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { defineAgent, defineTool, type AgentSessionSnapshot } from '@alvin0/ai-agent-sdk-core/agent'

/**
 * Live finding (chat-agents S10): a steer that arrives while a model round is
 * streaming was appended ahead of that round's output. The next round then saw
 * "steer, then the work that ignored it" and treated the steer as handled.
 */
describe('AgentSession.inject during a run', () => {
  it('schedules idle and queued managed-team notices as work', async () => {
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    const requests: GenerateOptions[] = []
    const notice = () => createUserMessage({ source: { kind: 'app', producer: 'managed-team' }, content: [{ type: 'text', text: 'Workers settled.' }] })
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        if (requests.length === 1) session.inject(notice())
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `Answer ${requests.length}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry(); registry.registerAdapter(['fixture'], new Model())
    session = defineAgent({ id: 'managed-notice', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 4, compaction: false }).createSession({ registry })
    session.inject(notice())
    expect(session.hasUnansweredInput()).toBe(true)
    const result = await session.runPending()
    expect(result.text).toBe('Answer 2')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages.at(-1)?.source).toEqual({ kind: 'app', producer: 'managed-team' })
    expect(session.hasUnansweredInput()).toBe(false)
  })

  it.each(['empty', 'whitespace', 'reasoning'] as const)('does not complete a steer with a previous answer after a %s reply', async reply => {
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    let calls = 0
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      override async *stream(): AsyncIterable<StreamChunk> {
        if (++calls === 1) {
          session.inject('Answer the new request')
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Previous answer' } }
        } else if (reply === 'whitespace') {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '   ' } }
        } else if (reply === 'reasoning') {
          yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Thinking only' } }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry(); registry.registerAdapter(['fixture'], new Model())
    session = defineAgent({ id: 'empty-steer', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 4, compaction: false }).createSession({ registry })
    const result = await session.run('Start')
    expect(calls).toBe(2)
    expect(result.text.trim()).toBe('')
    expect(result.outcome.completed).toBe(false)
    if (reply === 'empty') expect(session.hasUnansweredInput()).toBe(true)
  })

  it('ignores app notices without hiding genuine unanswered input', () => {
    const registry = new ModelRegistry()
    const session = defineAgent({ id: 'pending', provider: 'fixture', model: 'm', instructions: 'x', compaction: false }).createSession({ registry })
    const notice = () => createUserMessage({ source: { kind: 'app', producer: 'notice' }, content: [{ type: 'text', text: 'FYI' }] })
    session.history.append({ kind: 'user', message: notice() })
    expect(session.hasUnansweredInput()).toBe(false)
    session.inject('New task')
    session.history.append({ kind: 'user', message: notice() })
    expect(session.hasUnansweredInput()).toBe(true)
  })
  it('delivers steering before recovery and retry after a failed checkpoint', async () => {
    const requests: string[][] = []
    let preparations = 0
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry(); registry.registerAdapter(['fixture'], new Model())
    const session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 4, compaction: false }).createSession({
      registry, hooks: {
        checkpoint(context) {
          if (context.kind === 'before-model-request' && preparations === 1) {
            session.inject('CHECKPOINT STEERING')
            throw new Error('checkpoint unavailable')
          }
        },
        onRequestError() {
          expect(session.history.messages().at(-1)?.content).toEqual([{ type: 'text', text: 'CHECKPOINT STEERING' }])
          session.inject('RECOVERY STEERING')
          return 'retry'
        },
        beforeStep() {
          if (++preparations === 2) session.inject('RETRY HOOK STEERING')
          return { kind: 'proceed' }
        },
      },
    })
    const result = await session.run('start')
    expect(result.outcome.completed).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.slice(-3)).toEqual(['CHECKPOINT STEERING', 'RECOVERY STEERING', 'RETRY HOOK STEERING'])
    expect(session.history.messages().at(-1)?.role).toBe('assistant')
  })

  it('keeps shared application projections isolated across parallel sessions', async () => {
    const requests: GenerateOptions[] = []
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    const projection = Object.freeze({ kind: 'proceed' as const, messages: Object.freeze([]) })
    let entered = 0, release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const agent = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', compaction: false })
    const sessions = [0, 1].map(() => agent.createSession({ registry, hooks: { async beforeStep() {
      if (++entered === 2) release()
      await barrier
      return projection
    } } }))
    await Promise.all(sessions.map((session, index) => session.run(`PRIVATE/parallel%${index}`)))
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.messages)).toEqual([[], []])
    expect(sessions.map(session => JSON.stringify(session.snapshot()).includes('PRIVATE/parallel%'))).toEqual([true, true])
  })
  it.each([false, true])('makes drained steering visible to application hooks before projection (redact=%s)', async redact => {
    const requests: GenerateOptions[] = [], hookInputs: string[] = []
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        if (requests.length === 1) {
          session.inject('PRIVATE/queued%constraint')
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('read'), name: 'read', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    const registry = new ModelRegistry(); registry.registerAdapter(['fixture'], new Model())
    session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 4, compaction: false,
      tools: [defineTool({ name: 'read', description: 'Read', parameters: { type: 'object' }, execute: () => 'read receipt' })] }).createSession({ registry,
      hooks: { beforeStep(context) {
        hookInputs.push(JSON.stringify({ messages: context.messages, snapshot: context.snapshot }))
        return { kind: 'proceed', messages: context.messages.filter(message => !redact || !JSON.stringify(message).includes('PRIVATE/queued%constraint')) }
      } },
    })
    await session.run('start')
    expect(hookInputs[1]).toContain('PRIVATE/queued%constraint')
    const payload = JSON.stringify(requests[1]?.messages)
    if (redact) expect(payload).not.toContain('PRIVATE/queued%constraint')
    else expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'PRIVATE/queued%constraint' }])
  })
  it('retains queued input in an active snapshot and resumes it without delivering it early', async () => {
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    let captured: AgentSessionSnapshot | undefined
    let rounds = 0
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(): AsyncIterable<StreamChunk> {
        if (++rounds > 1) {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answered the queued input' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
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
    // A snapshot taken mid-run keeps the queued input as the next thing to answer.
    const resumed = agent.resumeSession({ registry, snapshot: JSON.parse(JSON.stringify(captured)) })
    expect(resumed.history.messages().at(-1)?.content).toEqual([{ type: 'text', text: 'QUEUED INPUT' }])
    // The live run answers it itself, after the round that could not see it.
    expect(rounds).toBe(2)
    // Budget notices the loop adds for itself are app-sourced; compare the dialogue.
    expect(session.history.messages().filter(message => message.source.kind !== 'app')
      .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')))
      .toEqual(['start', 'done', 'QUEUED INPUT', 'answered the queued input'])
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
        if (context.kind === 'before-model-request' && requests.length === 0) {
          await Promise.resolve()
          session.inject('CHECKPOINT INPUT')
        }
      } },
    })
    await session.run('start')
    // Never folded into the request that was already built...
    expect(requests[0]).not.toContain('CHECKPOINT INPUT')
    // ...but answered by the next one in the same run, after that answer.
    expect(requests).toHaveLength(2)
    expect(requests[1]?.indexOf('CHECKPOINT INPUT')).toBeGreaterThan(requests[1]?.indexOf('already requested') ?? Infinity)
    expect(session.history.messages().filter(message => message.source.kind !== 'app').map(message => message.role))
      .toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('answers input sent during the final answer in the same run, in arrival order, after that answer', async () => {
    const requests: string[][] = []
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
        if (requests.length === 1) { session.inject('FIRST'); session.inject('SECOND') }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer ' + requests.length } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 4, compaction: false }).createSession({ registry })
    const result = await session.run('start')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.slice(-3)).toEqual(['answer 1', 'FIRST', 'SECOND'])
    expect(result.text).toBe('answer 2')
    expect(session.isRunning).toBe(false)
  })

  it('leaves final-round input for runPending when the run has no steps left', async () => {
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    let calls = 0
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(): AsyncIterable<StreamChunk> {
        if (++calls === 1) session.inject('LATE')
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer ' + calls } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 1, compaction: false }).createSession({ registry })
    await session.run('start')
    // One step allowed: the run cannot answer it, and it is not lost either.
    expect(calls).toBe(1)
    expect(session.history.messages().at(-1)?.content).toEqual([{ type: 'text', text: 'LATE' }])
    await session.runPending()
    expect(calls).toBe(2)
    expect(session.history.messages().at(-1)?.role).toBe('assistant')
  })

  it('does not run an extra round when the run ends with nothing queued', async () => {
    let calls = 0
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32_000 } } }
      override async *stream(): AsyncIterable<StreamChunk> {
        calls++
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    await defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 4, compaction: false })
      .createSession({ registry }).run('start')
    expect(calls).toBe(1)
  })

  it.each(['error', 'max-tokens'] as const)('keeps late input for recovery after %s without starting another round', async finish => {
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    const requests: GenerateOptions[] = []
    class Model extends ModelAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        if (requests.length === 1) {
          session.inject('LATE RECOVERY INPUT')
          yield { type: 'text-delta', index: 0, text: 'partial answer' }
          yield { type: 'finish', reason: finish === 'error'
            ? { kind: 'error', failure: { code: 'UNAVAILABLE', message: 'fixture unavailable' } }
            : { kind: 'max-tokens' } }
        } else {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered answer' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['fixture'], new Model())
    session = defineAgent({ id: 'a', provider: 'fixture', model: 'm', instructions: 'x', maxTurns: 4, compaction: false })
      .createSession({ registry })
    const first = await session.run('start')
    expect(first.outcome.reason.kind).toBe(finish)
    expect(requests).toHaveLength(1)
    expect(session.hasUnansweredInput()).toBe(true)
    expect(session.isRunning).toBe(false)
    expect(session.history.messages().at(-1)?.content).toEqual([{ type: 'text', text: 'LATE RECOVERY INPUT' }])
    const second = await session.runPending()
    expect(second.text).toBe('recovered answer')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'LATE RECOVERY INPUT' }])
    expect(session.hasUnansweredInput()).toBe(false)
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
