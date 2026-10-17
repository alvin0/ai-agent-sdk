import { describe, expect, it } from 'vitest'
import { History, defineTool, runTurn, ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import type { AgentEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter, ModelRegistry, ToolCallId, createTextMessage } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { resolveBounds } from '../../packages/core/src/agent/loop/turn/config.ts'
import { resolveLimits } from '../../packages/core/src/agent/accounting/ledger-support.ts'
import { resolveRuntimeLimits } from '../../packages/core/src/agent/define/session/config.ts'
import { hookTimeout } from '../../packages/core/src/agent/loop/turn/hooks.ts'
import { managedLimits } from '../../packages/core/src/agent/team/managed-options.ts'
import { teamTimeouts } from '../../packages/core/src/agent/team/team-support.ts'

type Round = readonly StreamChunk[] | (() => AsyncIterable<StreamChunk>)

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly Round[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const round = this.rounds[this.requests.length - 1] ?? []
    yield * typeof round === 'function' ? round() : round
  }
}

function toolRound(id: string, name: string, args = '{"value":1}'): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textRound(text: string): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Five text deltas, `gapMs` apart: alive the whole time, but longer than any single gap. */
function slowStream(gapMs: number, stallMs = 0): () => AsyncIterable<StreamChunk> {
  return async function * () {
    for (let index = 0; index < 5; index++) {
      await sleep(index === 2 ? stallMs || gapMs : gapMs)
      yield { type: 'text-delta', index: 0, text: `part-${index} ` }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'part-0 part-1 part-2 part-3 part-4 ' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function run(rounds: readonly Round[], options: Record<string, unknown> = {}, failing = false) {
  const adapter = new ScriptedAdapter(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('do it') })
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: 'echo', description: 'Echo input.', parameters: { type: 'object' },
    execute: () => { if (failing) throw new Error('boom'); return { ok: true } },
  }))
  let end: Extract<AgentEvent, { type: 'turn-end' }> | undefined
  for await (const event of runTurn({
    registry, config: { provider: 'test', model: 'm' }, history, tools, ...options,
  } as Parameters<typeof runTurn>[0])) if (event.type === 'turn-end') end = event
  return { adapter, end: end! }
}

function occurrences(text: string, needle: string): number { return text.split(needle).length - 1 }

describe('limits are opt-in by default', () => {
  it('resolves every count, loop and duration bound to unlimited', () => {
    expect(resolveBounds(undefined)).toMatchObject({
      maxSteps: 'auto', maxTotalTokens: 'auto', maxTurnDurationMs: 'auto',
      maxToolCalls: Infinity, maxConsecutiveToolErrors: Infinity, repeatToolLimit: Infinity,
      toolCycleLimit: Infinity, maxToolDurationMs: Infinity,
      repeatToolWarningAt: 3, toolCycleWarningAt: 2, consecutiveToolErrorWarningAt: 4,
    })
    expect(resolveLimits(undefined)).toMatchObject({
      maxModelCalls: Infinity, maxToolCalls: Infinity, maxSerializedBytes: Infinity,
    })
    expect(hookTimeout(undefined)).toBeUndefined()
    expect(hookTimeout('auto')).toBeUndefined()
    expect(managedLimits({} as never).workerTimeoutMs).toBeUndefined()
    expect(teamTimeouts({} as never, 120_000, 1_000).operationTimeoutMs).toBeUndefined()
  })

  it("accepts 'auto' and numbers for opt-in session limits and still checks warning order", () => {
    expect(() => resolveRuntimeLimits({
      repeatToolLimit: 'auto', toolCycleLimit: 'auto', maxConsecutiveToolErrors: 'auto',
      maxToolDurationMs: 'auto', modelTimeoutMs: 'auto', hookTimeoutMs: 'auto', repeatToolWarningAt: 9,
    })).not.toThrow()
    expect(() => resolveRuntimeLimits({ repeatToolLimit: 2, repeatToolWarningAt: 3 })).toThrow(/repeatToolLimit/)
    expect(() => resolveRuntimeLimits({ teardownTimeoutMs: 'auto' as never })).toThrow(/teardownTimeoutMs/)
  })

  it('runs past every old default wall and keeps steering with periodic repeat warnings', async () => {
    // 70 identical calls: beyond the old 16-step, 64-tool-call and 6-repeat defaults.
    const calls = Array.from({ length: 70 }, (_, index) => toolRound(`c${index}`, 'echo'))
    const { adapter, end } = await run([...calls, textRound('done')])

    expect(end.outcome).toMatchObject({ steps: 71, toolCalls: 70 })
    expect(end.outcome.reason.kind).not.toBe('budget-exhausted')
    expect(adapter.requests.at(-1)?.toolChoice).not.toBe('none')
    const last = JSON.stringify(adapter.requests.at(-1)?.messages)
    // Warn-only: the reminder fires at every multiple of repeatToolWarningAt (3).
    expect(occurrences(last, 'consecutive times. Reassess')).toBe(23)
  })

  it('never stops on consecutive tool errors by default, warning every fourth failure', async () => {
    const calls = Array.from({ length: 10 }, (_, index) => toolRound(`e${index}`, 'echo', `{"value":${index}}`))
    const { adapter, end } = await run([...calls, textRound('recovered')], {}, true)

    expect(end.outcome).toMatchObject({ steps: 11, toolCalls: 10 })
    expect(end.outcome.reason.kind).not.toBe('budget-exhausted')
    const last = JSON.stringify(adapter.requests.at(-1)?.messages)
    expect(occurrences(last, 'tool calls failed. Read the errors')).toBe(2)
  })

  it('still enforces a loop limit the caller opts in to', async () => {
    const calls = Array.from({ length: 10 }, (_, index) => toolRound(`r${index}`, 'echo'))
    const { end } = await run([...calls, textRound('final')], { bounds: { repeatToolLimit: 4, maxToolCalls: 64 } })
    expect(end.outcome.reason).toMatchObject({ kind: 'budget-exhausted', budget: 'repeated-tool-call' })
  })

  it('never cuts a live model stream that outlasts the idle timeout in total', async () => {
    const { end } = await run([slowStream(40)], { modelIdleTimeoutMs: 120 })
    expect(end.outcome.text).toContain('part-4')
  })

  it('cuts a model stream that goes silent for the idle timeout', async () => {
    const { end } = await run([slowStream(5, 400)], { modelIdleTimeoutMs: 60 })
    expect(JSON.stringify(end.outcome)).toContain('model stream sent no data for 60ms')
  })

  it('applies a total model deadline only when the caller sets one', async () => {
    const { end } = await run([slowStream(40)], { modelIdleTimeoutMs: 1_000, modelTimeoutMs: 90 })
    expect(JSON.stringify(end.outcome)).toContain('model stream exceeded 90ms')
  })
})
