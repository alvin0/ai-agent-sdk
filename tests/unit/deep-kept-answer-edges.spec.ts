import { describe, expect, it } from 'vitest'
import {
  defineTool, History, runAgent, ToolRegistry, UNCHANGED_ANSWER_MARKER, type AgentRunEvent,
} from '@alvin0/ai-agent-sdk-core/agent'
import { createTextMessage, ModelAdapter, ModelRegistry, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'

/**
 * Boundary cases of the deep-mode kept answer: every path through the hold in
 * `driveAgent` that is not the plain "draft, check, marker" case, and the ones
 * where holding back text could lose real content.
 */

type Round = readonly StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>)

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly Round[]) { super() }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const round = this.rounds[this.requests.length - 1] ?? textRound('unexpected extra round')
    if (typeof round === 'function') yield* round(options)
    else for (const chunk of round) yield chunk
  }
}

function textRound(...parts: string[]): StreamChunk[] {
  return [
    ...parts.map((text): StreamChunk => ({ type: 'text-delta', index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: parts.join('') } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolRound(id: string, name: string, args: unknown = {}): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const submit = (id: string) => toolRound(id, 'submit_result', { summary: 'Checked.', evidence: ['reviewed'] })

function setup(rounds: readonly Round[]) {
  const adapter = new ScriptedAdapter(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('answer the question') })
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: 'lookup', description: 'Look something up.', parameters: { type: 'object' },
    execute: () => ({ found: 'new evidence' }),
  }))
  return { adapter, registry, history, tools }
}

async function collect(options: Parameters<typeof runAgent>[0]): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = []
  for await (const event of runAgent(options)) events.push(event)
  return events
}

async function runDeep(rounds: readonly Round[], extra: Partial<Parameters<typeof runAgent>[0]> = {}) {
  const state = setup(rounds)
  const events = await collect({
    mode: 'deep', registry: state.registry, config: { provider: 'test', model: 'm' },
    history: state.history, tools: state.tools, maxTurns: 8, ...extra,
  } as Parameters<typeof runAgent>[0])
  const end = events.at(-1)
  if (end?.type !== 'agent-end') throw new Error('run did not end with agent-end')
  return { ...state, events, outcome: end.outcome }
}

/** Streamed text of one model round, in the order the consumer received it. */
const streamedIn = (events: readonly AgentRunEvent[], step: number): string => {
  let current = 0
  let text = ''
  for (const event of events) {
    if (event.type === 'step-start') current = event.step
    else if (event.type === 'text-delta' && current === step) text += event.text
  }
  return text
}

const lastAssistantText = (history: History): string | undefined => history.messages()
  .filter(message => message.role === 'assistant')
  .at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')

const DRAFT = 'The complete answer, given before the check.'

/** Content events that carry the marker; trace spans and the offering tool result may. */
const contentLeaks = (events: readonly AgentRunEvent[], needle = UNCHANGED_ANSWER_MARKER): string[] => events
  .filter(event => !(event.type === 'tool-result' && event.call.toolName === 'submit_result'))
  .filter(event => event.type !== 'span-start' && event.type !== 'span-end')
  .filter(event => JSON.stringify(event).includes(needle))
  .map(event => event.type)

describe('deep kept answer: boundary cases', () => {
  it('a confirming reply cut off mid-marker keeps the draft instead of showing the fragment', async () => {
    const partial = UNCHANGED_ANSWER_MARKER.slice(0, 10)
    const run = await runDeep([
      textRound(DRAFT),
      submit('s1'),
      [
        { type: 'text-delta', index: 0, text: partial },
        { type: 'block-end', index: 0, block: { type: 'text', text: partial } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    ])
    // Text that is only the start of the marker can only be the marker arriving.
    // Releasing it would wipe a good answer for a fragment of a control token.
    expect(run.outcome.text).toBe(DRAFT)
    expect(run.outcome.completed).toBe(false)
    expect(streamedIn(run.events, 3)).toBe('')
    expect(lastAssistantText(run.history)).toBe(DRAFT)
    expect(contentLeaks(run.events, partial)).toEqual([])
  })

  it('a marker sent alongside a tool call is released and the run carries on', async () => {
    const run = await runDeep([
      textRound(DRAFT),
      submit('s1'),
      [
        { type: 'text-delta', index: 0, text: UNCHANGED_ANSWER_MARKER },
        { type: 'block-end', index: 0, block: { type: 'text', text: UNCHANGED_ANSWER_MARKER } },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('l1'), name: 'lookup', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      submit('s2'),
      textRound('Final answer after the extra lookup.'),
    ])
    expect(run.outcome).toMatchObject({ completed: true, text: 'Final answer after the extra lookup.' })
    // Real content beside it, so the hold let go: nothing was dropped.
    expect(streamedIn(run.events, 3)).toBe(UNCHANGED_ANSWER_MARKER)
  })

  it('keeps the latest draft when the gate fired more than once', async () => {
    const run = await runDeep([
      textRound('First wording.'),
      textRound('Second, better wording.'),
      submit('s1'),
      textRound(UNCHANGED_ANSWER_MARKER),
    ])
    expect(run.outcome).toMatchObject({ completed: true, text: 'Second, better wording.' })
    expect(lastAssistantText(run.history)).toBe('Second, better wording.')
  })

  it('keeps the draft when tool work between the draft and the accept found nothing new', async () => {
    const run = await runDeep([
      textRound(DRAFT),
      toolRound('l1', 'lookup'),
      submit('s1'),
      textRound(UNCHANGED_ANSWER_MARKER),
    ])
    expect(run.outcome).toMatchObject({ completed: true, text: DRAFT })
    expect(lastAssistantText(run.history)).toBe(DRAFT)
  })

  it('leaves basic mode alone: there is no self-check, so the marker is ordinary text', async () => {
    const state = setup([textRound(UNCHANGED_ANSWER_MARKER)])
    const events = await collect({ mode: 'basic', registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, maxTurns: 2 })
    expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: { text: UNCHANGED_ANSWER_MARKER } })
    expect(state.adapter.requests[0]?.tools?.map(tool => tool.name)).not.toContain('submit_result')
  })

  it('does not offer the marker when nothing was answered before the check', async () => {
    const run = await runDeep([submit('s1'), textRound('The only answer.')])
    expect(JSON.stringify(run.adapter.requests[1]?.messages)).not.toContain(UNCHANGED_ANSWER_MARKER)
    expect(run.outcome).toMatchObject({ completed: true, text: 'The only answer.' })
  })

  it('never presents the marker as an answer when the model sends it with no draft to keep', async () => {
    // A later run can see an earlier run's accept instruction in history and
    // imitate it. With nothing answered in this run there is nothing to keep,
    // and the marker must not stand as a completed answer.
    const run = await runDeep([submit('s1'), textRound(UNCHANGED_ANSWER_MARKER), textRound('The real answer.')])
    // Asked once for the answer itself, which it then gives.
    expect(run.adapter.requests).toHaveLength(3)
    expect(JSON.stringify(run.adapter.requests[2]?.messages)).toContain('There is no earlier answer in this run')
    expect(run.outcome).toMatchObject({ completed: true, text: 'The real answer.' })
    expect(contentLeaks(run.events)).toEqual([])
  })

  it('ends incomplete and empty, not with the marker, when the model repeats it after being asked', async () => {
    const run = await runDeep([submit('s1'), textRound(UNCHANGED_ANSWER_MARKER), textRound(UNCHANGED_ANSWER_MARKER)])
    expect(run.adapter.requests).toHaveLength(3)
    expect(run.outcome).toMatchObject({ completed: false, text: '' })
    expect(contentLeaks(run.events)).toEqual([])
    expect(lastAssistantText(run.history)).toBe('')
  })

  it('keeps an earlier run\'s answer out of a later run', async () => {
    const first = await runDeep([textRound('Answer to the first question.'), submit('s1'), textRound(UNCHANGED_ANSWER_MARKER)])
    first.history.append({ kind: 'user', message: createTextMessage('a second question') })
    const adapter = new ScriptedAdapter([textRound('Answer to the second question.'), submit('s2'), textRound(UNCHANGED_ANSWER_MARKER)])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const events = await collect({ mode: 'deep', registry, config: { provider: 'test', model: 'm' },
      history: first.history, tools: first.tools, maxTurns: 8 })
    expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: { completed: true, text: 'Answer to the second question.' } })
    const answers = first.history.messages().filter(message => message.role === 'assistant')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    expect(answers).toContain('Answer to the first question.')
    expect(answers.at(-1)).toBe('Answer to the second question.')
    expect(answers.some(text => text.includes(UNCHANGED_ANSWER_MARKER))).toBe(false)
  })

  it('an aborted confirming round rejects like any aborted run and never shows the marker fragment', async () => {
    const controller = new AbortController()
    const state = setup([
      textRound(DRAFT),
      submit('s1'),
      async function* (options) {
        yield { type: 'text-delta', index: 0, text: UNCHANGED_ANSWER_MARKER.slice(0, 8) }
        controller.abort()
        await new Promise(resolve => options.signal?.addEventListener('abort', resolve, { once: true }) ?? setTimeout(resolve, 0))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stopped' } } }
      },
    ])
    const events: AgentRunEvent[] = []
    await expect((async () => {
      for await (const event of runAgent({ mode: 'deep', registry: state.registry, config: { provider: 'test', model: 'm' },
        history: state.history, tools: state.tools, maxTurns: 8, signal: controller.signal })) events.push(event)
    })()).rejects.toThrow(/abort/i)
    expect(streamedIn(events, 3)).toBe('')
    expect(contentLeaks(events, UNCHANGED_ANSWER_MARKER.slice(0, 8))).toEqual([])
    // Stop must not cost the answer: the interrupted fragment is superseded on
    // the surface a reload reads, even though the run never reached turn-end.
    expect(lastAssistantText(state.history)).toBe(DRAFT)
    expect(streamedIn(events, 1)).toBe(DRAFT)
  })

  it('a provider error during the marker round is reported, not hidden behind the draft', async () => {
    const run = await runDeep([
      textRound(DRAFT),
      submit('s1'),
      [
        { type: 'text-delta', index: 0, text: UNCHANGED_ANSWER_MARKER.slice(0, 8) },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'UNAVAILABLE', message: 'provider down' } } },
      ],
    ], { maxTurns: 3, bounds: { onExhausted: 'continue' } })
    expect(run.outcome.reason.kind).toBe('error')
    expect(run.outcome.completed).toBe(false)
    expect(streamedIn(run.events, 3)).toBe('')
  })

  it('a confirming reply from a reasoning model still counts as the marker; its reasoning stays visible', async () => {
    const run = await runDeep([
      textRound(DRAFT),
      submit('s1'),
      [
        { type: 'reasoning-delta', index: 0, text: 'Nothing to change.' },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Nothing to change.' } },
        { type: 'text-delta', index: 1, text: UNCHANGED_ANSWER_MARKER },
        { type: 'block-end', index: 1, block: { type: 'text', text: UNCHANGED_ANSWER_MARKER } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ])
    // Reasoning models attach reasoning to the reply. It is not something the
    // reply says to the user, so the reply is still only the marker.
    expect(run.events.some(event => event.type === 'reasoning-delta' && event.text === 'Nothing to change.')).toBe(true)
    expect(run.outcome).toMatchObject({ completed: true, text: DRAFT })
    expect(streamedIn(run.events, 3)).toBe('')
    expect(contentLeaks(run.events)).toEqual([])
    expect(lastAssistantText(run.history)).toBe(DRAFT)
    const last = run.history.messages().filter(message => message.role === 'assistant').at(-1)
    expect(last?.content).toContainEqual({ type: 'reasoning', text: 'Nothing to change.' })
    const reasoning = run.events.findLast(event => event.type === 'assistant-reasoning')
    expect(reasoning).toMatchObject({ messageId: last?.id, text: 'Nothing to change.' })
  })

  it('persists the same empty reply and reasoning it emits when no draft can be kept', async () => {
    const run = await runDeep([
      submit('s1'),
      [
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Checked the result.' } },
        { type: 'block-end', index: 1, block: { type: 'text', text: UNCHANGED_ANSWER_MARKER } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ], { maxTurns: 2 })
    expect(run.outcome).toMatchObject({ completed: false, text: '' })
    const last = run.history.messages().filter(message => message.role === 'assistant').at(-1)
    expect(last?.content).toEqual([{ type: 'reasoning', text: 'Checked the result.' }])
    const emitted = run.events.findLast(event => event.type === 'assistant-message')
    expect(emitted).toMatchObject({ message: last })
    expect(run.events.findLast(event => event.type === 'assistant-reasoning'))
      .toMatchObject({ messageId: last?.id, text: 'Checked the result.' })
    expect(contentLeaks(run.events)).toEqual([])
    const reloaded = History.fromSnapshot(JSON.parse(JSON.stringify(run.history.snapshot())))
    expect(reloaded.messages().at(-1)).toEqual(last)
  })

  it('reports a failed history replacement instead of completing with a different persisted message', async () => {
    const state = setup([textRound(DRAFT), submit('s1'), textRound(UNCHANGED_ANSWER_MARKER)])
    // Seven entries admit the real marker reply, but not its append-only
    // replacement. A successful outcome must never hide that storage failure.
    const history = new History({ maxEntries: 7 })
    history.append({ kind: 'user', message: createTextMessage('answer the question') })
    const events: AgentRunEvent[] = []
    await expect((async () => {
      for await (const event of runAgent({ mode: 'deep', registry: state.registry,
        config: { provider: 'test', model: 'm' }, history, tools: state.tools, maxTurns: 8 })) events.push(event)
    })()).rejects.toThrow(/history.*limit/i)
    expect(state.adapter.requests).toHaveLength(3)
    expect(events.some(event => event.type === 'agent-end')).toBe(false)
    expect(contentLeaks(events)).toEqual([])
  })

  it.each([
    { draft: true, finish: 'stop' as const }, { draft: false, finish: 'stop' as const },
    { draft: true, finish: 'max-tokens' as const }, { draft: false, finish: 'max-tokens' as const },
  ])('preserves marker text accompanied by an image (draft=$draft, finish=$finish)', async ({ draft, finish }) => {
    const image = { type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.com/result.png' } }
    const run = await runDeep([
      ...draft ? [textRound(DRAFT)] : [], submit('s1'),
      [
        { type: 'text-delta', index: 0, text: UNCHANGED_ANSWER_MARKER },
        { type: 'block-end', index: 0, block: { type: 'text', text: UNCHANGED_ANSWER_MARKER } },
        { type: 'block-end', index: 1, block: image },
        { type: 'finish', reason: { kind: finish } },
      ],
    ])
    expect(run.adapter.requests).toHaveLength(draft ? 3 : 2)
    expect(streamedIn(run.events, draft ? 3 : 2)).toBe(UNCHANGED_ANSWER_MARKER)
    expect(run.outcome.text).toBe(UNCHANGED_ANSWER_MARKER)
    expect(lastAssistantText(run.history)).toBe(UNCHANGED_ANSWER_MARKER)
    expect(run.history.messages().at(-1)?.content).toContainEqual(image)
  })
})
