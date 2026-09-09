import { describe, expect, it } from 'vitest'
import { History, runTurn } from '@ai-agent-sdk/core/agent'
import { defineTool, ToolRegistry } from '@ai-agent-sdk/core/agent'
import { ModelAdapter, ModelRegistry, ToolCallId, createTextMessage } from '@ai-agent-sdk/core'
import { defineContextSection } from '@ai-agent-sdk/core'
import { captureContextSections } from '../../packages/core/src/agent/context/section.ts'
import type { ContextSection, ContextToolTouch } from '@ai-agent-sdk/core'
import type { GenerateOptions, StreamChunk } from '@ai-agent-sdk/core'

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(readonly rounds: StreamChunk[][]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
}

function textRound(text: string): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

let callSeq = 0
function toolRound(name: string, args: string): StreamChunk[] {
  callSeq++
  return [
    {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: ToolCallId(`call-${callSeq}`), name, arguments: args },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function setup(rounds: StreamChunk[][]) {
  const adapter = new ScriptedAdapter(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('do it') })
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: 'read', description: 'Read a file.', parameters: { type: 'object' },
    parse: value => value as { file_path: string },
    execute: ({ file_path }) => ({ file_path }),
    isConcurrencySafe: () => true,
  }))
  return { adapter, registry, history, tools }
}

async function drain(options: Parameters<typeof runTurn>[0]): Promise<void> {
  for await (const _event of runTurn(options)) { /* drain */ }
}

/** Text of every app message a section produced, in surface order. */
function sectionTexts(history: History, id: string): string[] {
  return history.messages().flatMap(message => (
    message.source.kind === 'app' && message.source.producer === `context-section:${id}`
      ? message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : []
  ))
}

describe('context sections', () => {
  it('writes a section before the first model round and leaves an unchanged revision alone', async () => {
    const state = setup([toolRound('read', '{"file_path":"a.ts"}'), textRound('done')])
    let resolves = 0
    const section = defineContextSection({
      id: 'project-notes',
      resolve() {
        resolves++
        return { revision: 'v1', text: 'Always run the linter.' }
      },
    })

    await drain({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, contextSections: [section],
    })

    expect(resolves).toBe(2)
    expect(sectionTexts(state.history, 'project-notes')).toEqual(['Always run the linter.'])
    const first = state.adapter.requests[0]
    expect(JSON.stringify(first?.messages)).toContain('Always run the linter.')
  })

  it('replaces its own node rather than appending a second copy', async () => {
    const state = setup([toolRound('read', '{"file_path":"a.ts"}'), textRound('done')])
    let step = 0
    const section = defineContextSection({
      id: 'project-notes',
      resolve() {
        step++
        return { revision: `v${step}`, text: `revision ${step}` }
      },
    })

    await drain({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, contextSections: [section],
    })

    // Two writes, one live node: the model never reads both revisions.
    expect(sectionTexts(state.history, 'project-notes')).toEqual(['revision 2'])
    expect(JSON.stringify(state.adapter.requests[1]?.messages)).not.toContain('revision 1')
  })

  it('retracts with a notice when the section stops applying', async () => {
    const state = setup([toolRound('read', '{"file_path":"a.ts"}'), textRound('done')])
    let call = 0
    const section = defineContextSection({
      id: 'project-notes',
      retractionText: 'The earlier project notes no longer apply.',
      resolve() {
        call++
        return call === 1 ? { revision: 'v1', text: 'Always run the linter.' } : undefined
      },
    })

    await drain({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, contextSections: [section],
    })

    expect(sectionTexts(state.history, 'project-notes'))
      .toEqual(['The earlier project notes no longer apply.'])
  })

  it('reports the tool calls committed since the previous resolve', async () => {
    const state = setup([toolRound('read', '{"file_path":"pkg/a.ts"}'), textRound('done')])
    const seen: (readonly ContextToolTouch[])[] = []
    const section = defineContextSection({
      id: 'touched-files',
      resolve(input) {
        seen.push(input.touches)
        return undefined
      },
    })

    await drain({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, contextSections: [section],
    })

    expect(seen[0]).toEqual([])
    expect(seen[1]).toEqual([
      { toolName: 'read', rawArguments: '{"file_path":"pkg/a.ts"}', failed: false },
    ])
  })

  it('keeps the turn alive when a section throws', async () => {
    const state = setup([textRound('done')])
    const section: ContextSection = defineContextSection({
      id: 'broken',
      resolve() { throw new Error('provider offline') },
    })

    await drain({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, contextSections: [section],
    })

    expect(sectionTexts(state.history, 'broken')).toEqual([])
    expect(state.adapter.requests).toHaveLength(1)
  })

  it('writes one retraction notice rather than one per step', async () => {
    const state = setup([
      toolRound('read', '{"file_path":"a.ts"}'),
      toolRound('read', '{"file_path":"b.ts"}'),
      textRound('done'),
    ])
    let call = 0
    const section = defineContextSection({
      id: 'project-notes',
      retractionText: 'Gone.',
      resolve() {
        call++
        return call === 1 ? { revision: 'v1', text: 'Present.' } : undefined
      },
    })

    await drain({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, contextSections: [section],
    })

    expect(call).toBe(3)
    // One notice replaces the content and then stands; steps 2 and 3 write nothing.
    expect(sectionTexts(state.history, 'project-notes')).toEqual(['Gone.'])
    expect(state.history.entries().filter(entry => (
      entry.event.kind === 'user'
      && entry.event.message.source.kind === 'app'
      && entry.event.message.source.producer === 'context-section:project-notes'
    ))).toHaveLength(2)
  })

  it('adopts its node from an earlier turn instead of appending a duplicate', async () => {
    const state = setup([textRound('first')])
    const section = defineContextSection({
      id: 'project-notes',
      resolve: () => ({ revision: 'v1', text: 'Always run the linter.' }),
    })
    const options = {
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, contextSections: [section],
    }

    await drain(options)
    // A second run is a second runTurn with a fresh section runtime over the
    // same history — the first turn's node is still on the surface.
    state.adapter.rounds.push(textRound('second'))
    state.history.append({ kind: 'user', message: createTextMessage('again') })
    await drain(options)

    expect(sectionTexts(state.history, 'project-notes')).toEqual(['Always run the linter.'])
  })

  it('rewrites an adopted node only when the text actually differs', async () => {
    const state = setup([textRound('first')])
    let revision = 0
    const section = defineContextSection({
      id: 'project-notes',
      resolve() {
        revision++
        // A digest-free producer that rekeys identical content every turn.
        return { revision: `v${revision}`, text: 'Always run the linter.' }
      },
    })
    const options = {
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, contextSections: [section],
    }

    await drain(options)
    const afterFirst = state.history.entries().length
    state.adapter.rounds.push(textRound('second'))
    state.history.append({ kind: 'user', message: createTextMessage('again') })
    await drain(options)

    expect(sectionTexts(state.history, 'project-notes')).toEqual(['Always run the linter.'])
    // The only new entries are the user message and the assistant reply.
    expect(state.history.entries().length).toBe(afterFirst + 2)
  })

  it('rewrites its context after a compaction shadowed the node', async () => {
    const state = setup([textRound('first')])
    const section = defineContextSection({
      id: 'project-notes',
      resolve: () => ({ revision: 'v1', text: 'Always run the linter.' }),
    })
    const options = {
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, contextSections: [section],
    }

    await drain(options)
    const written = state.history.surface()
      .find(node => node.message.source.kind === 'app'
        && node.message.source.producer === 'context-section:project-notes')!
    // Stand in for a compaction summary that shadows the section's node.
    state.history.append(
      {
        kind: 'user',
        message: createTextMessage('[summary of earlier context]'),
      },
      { op: 'replace', from: written.seq, to: written.seq, targets: [written.seq] },
    )
    expect(sectionTexts(state.history, 'project-notes')).toEqual([])

    state.adapter.rounds.push(textRound('second'))
    await drain(options)

    // The revision never changed, but the model can no longer read the text, so
    // the section must put it back rather than trust its own bookkeeping.
    expect(sectionTexts(state.history, 'project-notes')).toEqual(['Always run the linter.'])
  })

  it('rejects a non-kebab id and a duplicate id', () => {
    expect(() => defineContextSection({ id: 'Not Kebab', resolve: () => undefined }))
      .toThrow(/kebab-case/)
    expect(() => captureContextSections([
      defineContextSection({ id: 'notes', resolve: () => undefined }),
      defineContextSection({ id: 'notes', resolve: () => undefined }),
    ])).toThrow(/duplicate context section 'notes'/)
  })
})
