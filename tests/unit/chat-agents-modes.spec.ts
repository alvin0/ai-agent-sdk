import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolRegistry, createUserInputBroker, defineTool, runAgent } from '@ai-agent-sdk/core/agent'
import type { AgentRunEvent, SpillStore } from '@ai-agent-sdk/core/agent'
import { History } from '@ai-agent-sdk/core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId, createTextMessage } from '@ai-agent-sdk/core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@ai-agent-sdk/core'

const home = mkdtempSync(join(tmpdir(), 'modes-'))
process.env.CHAT_AGENTS_DB = join(home, '.data', 'test.db')
process.env.CHAT_AGENTS_WORKSPACE = join(home, 'sandbox')
process.env.CHAT_AGENTS_MIGRATIONS = join(process.cwd(), 'samples/chat-agents/backend/drizzle')

const { EventProjector } = await import('../../samples/chat-agents/backend/src/event-projection.ts')
const { createFileSpillStore } = await import('../../samples/chat-agents/backend/src/spill.ts')
const { startRun } = await import('../../samples/chat-agents/backend/src/agent-runtime.ts')
const { createApprovalPolicy } = await import('../../samples/chat-agents/backend/src/approvals.ts')
const { createSampleTools } = await import('../../samples/chat-agents/backend/src/tools.ts')

/**
 * The modes a conversation actually runs in, not just the team ones.
 *
 * Every policy this SDK grew for delegated runs — a spill store for oversized
 * output, a tool budget that pauses rather than walls, a retrieval tool — has to
 * hold for the single-agent modes too, because those are what most prompts use.
 * These are the awkward questions: what does the model see when a result is too
 * big, when a tool refuses, when the answer never comes.
 */

const text = (body: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text: body },
  { type: 'block-end', index: 0, block: { type: 'text', text: body, phase: 'final-answer' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const call = (id: string, name: string, args: unknown): StreamChunk[] => [
  {
    type: 'block-end', index: 0,
    block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) },
  },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

/** Raw arguments the model got wrong, which a schema cannot prevent. */
const malformedCall = (id: string, name: string, raw: string): StreamChunk[] => [
  {
    type: 'block-end', index: 0,
    block: { type: 'tool-call', id: ToolCallId(id), name, arguments: raw },
  },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

abstract class StubAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

/** Plays a fixed script, one round per request. */
class Scripted extends StubAdapter {
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const round = this.rounds[this.requests.length - 1]
    if (round === undefined) {
      yield* text('nothing left to say')
      return
    }
    yield* round
  }
}

interface RunResult {
  readonly events: AgentRunEvent[]
  readonly nodes: { kind: string; text?: string; state?: string; output?: string; name?: string }[]
  readonly requests: GenerateOptions[]
}

/**
 * Run one prompt the way the sample's single-agent branch does.
 * @param options - Script, tools, mode, and the policies under test.
 * @returns Events, projected transcript nodes, and what the model was sent.
 */
async function run(options: {
  readonly rounds: readonly (readonly StreamChunk[])[]
  readonly tools?: ToolRegistry
  readonly mode?: 'basic' | 'deep' | 'deep-human-in-loop'
  readonly spillStore?: SpillStore
  readonly bounds?: Record<string, unknown>
  readonly userInput?: ReturnType<typeof createUserInputBroker>
  readonly maxTurns?: number
  readonly approvals?: { broker: unknown; interceptor: unknown }
  readonly interceptors?: readonly unknown[]
  readonly onRound?: (index: number, history: History) => void
}): Promise<RunResult> {
  const adapter = new Scripted(options.rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('do the thing') })
  const project = new EventProjector()
  const events: AgentRunEvent[] = []
  const nodes: RunResult['nodes'] = []

  for await (const event of runAgent({
    mode: options.mode ?? 'basic',
    registry,
    config: { provider: 'test', model: 'scripted' },
    history,
    ...options.tools === undefined ? {} : { tools: options.tools },
    ...options.spillStore === undefined ? {} : { spillStore: options.spillStore },
    ...options.bounds === undefined ? {} : { bounds: options.bounds as never },
    ...options.userInput === undefined ? {} : { userInput: options.userInput },
    ...options.approvals === undefined ? {} : {
      approvals: options.approvals.broker,
      interceptors: [options.approvals.interceptor],
    },
    ...options.interceptors === undefined ? {} : { interceptors: options.interceptors },
    maxTurns: options.maxTurns ?? 6,
  } as never)) {
    events.push(event)
    for (const _wire of project.forLead(event)) { /* the client's copy */ }
    for (const node of project.flush()) nodes.push(node as RunResult['nodes'][number])
  }
  for (const node of project.flush()) nodes.push(node as RunResult['nodes'][number])
  return { events, nodes, requests: adapter.requests }
}

function toolsWith(...definitions: readonly ReturnType<typeof defineTool>[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const definition of definitions) registry.register(definition)
  return registry
}

describe('basic mode', () => {
  it('spills a result too large for the context and leaves a way back to it', async () => {
    // A `read_file` on a bundle. Truncating loses it; spilling keeps it, and
    // only if the retrieval tool is actually mounted can the model get it back.
    const store = createFileSpillStore()
    const huge = 'x'.repeat(40_000)
    const result = await run({
      spillStore: store,
      bounds: { maxToolResultTokens: 200 },
      tools: toolsWith(defineTool({
        name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
        execute: () => huge,
      })),
      rounds: [call('r1', 'read_file', { path: 'bundle.js' }), text('summarised it')],
    })

    const output = result.nodes.find(node => node.kind === 'tool')?.output ?? ''
    expect(output).toContain('read_tool_output')
    expect(output.length).toBeLessThan(2_000)
    // The tool the notice points at has to exist, or the advice is a dead end.
    expect(JSON.stringify(result.requests[0]?.tools)).toContain('read_tool_output')
  })

  it('answers a malformed tool call instead of ending the run', async () => {
    // Providers do emit arguments that are not valid JSON. The model has to be
    // able to correct itself rather than have the turn die on it.
    const result = await run({
      tools: toolsWith(defineTool({
        name: 'search', description: 'Search.', parameters: { type: 'object' },
        parse: (raw) => {
          if (typeof raw !== 'object' || raw === null) throw new TypeError('arguments must be an object')
          return raw as Record<string, unknown>
        },
        execute: () => ({ hits: 0 }),
      })),
      rounds: [
        malformedCall('m1', 'search', '{"query": '),
        text('recovered and answered'),
      ],
    })

    const tool = result.nodes.find(node => node.kind === 'tool')
    expect(tool?.state).toBe('error')
    // The correction round happened, and the run ended on an answer.
    expect(result.nodes.at(-1)).toMatchObject({ kind: 'text', text: 'recovered and answered' })
  })

  it('ends the turn when the model says nothing at all', async () => {
    // An empty round is a real provider outcome. The loop must treat it as an
    // ending rather than asking again forever.
    const result = await run({
      rounds: [[{ type: 'finish', reason: { kind: 'stop' } }]],
      maxTurns: 4,
    })

    expect(result.requests).toHaveLength(1)
    const end = result.events.find(event => event.type === 'agent-end')
    expect(end).toBeDefined()
  })

  it('keeps the transcript coherent when a tool fails outright', async () => {
    const result = await run({
      tools: toolsWith(defineTool({
        name: 'run_command', description: 'Run a command.', parameters: { type: 'object' },
        execute: () => { throw new Error('exit status 127') },
      })),
      rounds: [call('c1', 'run_command', { command: 'npm', args: ['test'] }), text('reported the failure')],
    })

    const tool = result.nodes.find(node => node.kind === 'tool')
    expect(tool?.state).toBe('error')
    // Every call has a result: a dangling call would break the next request.
    const calls = result.events.filter(event => event.type === 'tool-call').length
    const results = result.events.filter(event => event.type === 'tool-result').length
    expect(results).toBe(calls)
  })
})

describe('deep mode', () => {
  it('can still submit after the tool budget is spent', async () => {
    const result = await run({
      mode: 'deep',
      bounds: { maxToolCalls: 1 },
      tools: toolsWith(defineTool({
        name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
        execute: () => 'contents',
      })),
      rounds: [
        call('w1', 'read_file', { path: 'a.ts' }),
        call('s1', 'submit_result', { summary: 'Done.', evidence: ['read a.ts'] }),
        text('final answer'),
      ],
      maxTurns: 6,
    })

    const end = result.events.find(event => event.type === 'agent-end')
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(true)
  })

  it('stops re-asking a model that answers the same thing every time', async () => {
    // The self-check gate re-prompts until the model submits. A model that will
    // not submit answers the same words again and again — measured at nineteen
    // identical answers for one prompt, every one of them paid for and every one
    // of them written to the transcript. The gate has to give up on a model that
    // is plainly not listening.
    const result = await run({
      mode: 'deep',
      rounds: Array.from({ length: 12 }, () => text('the same answer every time')),
      maxTurns: 12,
    })

    const said = result.nodes.filter(node => node.kind === 'text')
    expect(said.length).toBeLessThanOrEqual(3)
    const end = result.events.find(event => event.type === 'agent-end')
    // Honest about it: nothing was submitted, so nothing is complete.
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(false)
  })

  it('does not count a submission the model made in the same batch as work', async () => {
    // Submitting alongside the work whose result it has not seen is a claim
    // about something that had not happened yet.
    const result = await run({
      mode: 'deep',
      tools: toolsWith(defineTool({
        name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
        execute: () => 'contents',
      })),
      rounds: [
        [
          {
            type: 'block-end', index: 0,
            block: { type: 'tool-call', id: ToolCallId('w1'), name: 'read_file', arguments: '{}' },
          },
          {
            type: 'block-end', index: 1,
            block: {
              type: 'tool-call', id: ToolCallId('s1'), name: 'submit_result',
              arguments: JSON.stringify({ summary: 'Done.', evidence: ['nothing yet'] }),
            },
          },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ],
        text('answered without a valid submission'),
      ],
      maxTurns: 3,
    })

    const end = result.events.find(event => event.type === 'agent-end')
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(false)
  })
})

describe('human-in-the-loop mode', () => {
  it('parks on the question and continues with the answer', async () => {
    const broker = createUserInputBroker()
    broker.onRequest((request) => {
      broker.resolve(request.requestId, { answers: { pick: { answers: ['PostgreSQL'] } } })
    })
    const result = await run({
      mode: 'deep-human-in-loop',
      userInput: broker,
      rounds: [
        call('q1', 'request_user_input', {
          questions: [{
            id: 'pick', header: 'Database', question: 'Which database?',
            options: [
              { label: 'PostgreSQL', description: 'relational' },
              { label: 'SQLite', description: 'embedded' },
            ],
          }],
        }),
        call('s1', 'submit_result', { summary: 'Used the answer.', evidence: ['user picked PostgreSQL'] }),
        text('done'),
      ],
    })

    expect(result.events.some(event => event.type === 'user-input-response')).toBe(true)
    // The answer reaches the model, not just the event stream.
    expect(JSON.stringify(result.requests[1])).toContain('PostgreSQL')
  })

  it('ends the run when the user abandons the question', async () => {
    const broker = createUserInputBroker()
    // The card is dismissed rather than answered — the broker's own way of
    // saying nobody is going to reply.
    broker.onRequest(() => { broker.abortAll() })
    const result = await run({
      mode: 'deep-human-in-loop',
      userInput: broker,
      rounds: [
        call('q1', 'request_user_input', {
          questions: [{
            id: 'pick', header: 'Database', question: 'Which database?',
            options: [
              { label: 'PostgreSQL', description: 'relational' },
              { label: 'SQLite', description: 'embedded' },
            ],
          }],
        }),
        text('stopped'),
      ],
    })

    const end = result.events.find(event => event.type === 'agent-end')
    // Abandoned is not completed: nothing was decided, so nothing was done.
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(false)
  })
})

describe('what the app actually configures for a single agent', () => {
  /**
   * Run one prompt through the sample's own `startRun`, so the assertions are
   * about the app's wiring rather than about options a test chose.
   * @param rounds - The scripted model rounds.
   * @param tool - The one workspace tool the agent is given.
   * @returns What the model was sent, and the events it produced.
   */
  async function appRun(
    rounds: readonly (readonly StreamChunk[])[],
    tool: ReturnType<typeof defineTool>,
  ): Promise<{ requests: GenerateOptions[]; events: AgentRunEvent[] }> {
    const adapter = new Scripted(rounds)
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    const events: AgentRunEvent[] = []
    const handles = await startRun('do the thing', {
      registry,
      provider: 'test',
      model: 'scripted',
      effort: undefined,
      mode: 'basic',
      workspaceRoot: join(home, 'sandbox'),
      groupId: 'default',
      workspaceTools: toolsWith(tool),
      userInput: createUserInputBroker(),
      agent: undefined,
      history,
      signal: new AbortController().signal,
    } as never, () => { /* no members in basic mode */ })
    for await (const event of handles.events) events.push(event as AgentRunEvent)
    return { requests: adapter.requests, events }
  }

  it('gives a single agent the same oversized-output policy as a team', async () => {
    // Every mode reads files and runs commands, so every mode can be handed a
    // result too large for its context. A team run spills it and can read it
    // back; a basic run had neither the store nor the tool, so the same output
    // was cut and gone.
    const huge = 'x'.repeat(80_000)
    const { requests } = await appRun(
      [call('r1', 'read_file', { path: 'bundle.js' }), text('summarised')],
      defineTool({
        name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
        execute: () => huge,
      }),
    )

    expect(JSON.stringify(requests[0]?.tools)).toContain('read_tool_output')
    const second = JSON.stringify(requests[1])
    expect(second).toContain('read_tool_output')
    // Spilled, not merely cut: the model is told where the rest is.
    expect(second).not.toContain('Re-run more narrowly')
  })

  it('does not wall a single agent at its tool budget either', async () => {
    // `onExhausted: continue` is the policy the app chose for its sessions. A
    // basic run that hits the wall instead gets its useful last call declined.
    const { requests, events } = await appRun(
      [
        call('c1', 'read_file', { path: 'a.ts' }),
        call('c2', 'read_file', { path: 'b.ts' }),
        call('c3', 'read_file', { path: 'c.ts' }),
        text('done'),
      ],
      defineTool({
        name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
        execute: () => 'contents',
      }),
    )

    void requests
    const declined = events.filter(event =>
      event.type === 'tool-result'
      && !event.result.isError
      && (event.result.meta as { declined?: unknown } | undefined)?.declined === true)
    expect(declined).toEqual([])
  })
})

describe('permission prompts', () => {
  /** The sample's own gate, over its own tools, in a real workspace. */
  function gate(): { policy: ReturnType<typeof createApprovalPolicy>; tools: ToolRegistry } {
    const workspaceRoot = join(home, 'sandbox')
    return {
      policy: createApprovalPolicy({ workspaceRoot, sessionGrants: new Set<string>() }),
      tools: createSampleTools(workspaceRoot) as unknown as ToolRegistry,
    }
  }

  it('lets the model carry on after the user says no', async () => {
    // A denial is an answer, not a crash: the model has to be able to propose
    // something else rather than have the run end on it.
    const { policy, tools } = gate()
    const answered = new Set<string>()
    const watch = setInterval(() => {
      for (const prompt of policy.pending()) {
        if (answered.has(prompt.callId)) continue
        answered.add(prompt.callId)
        void policy.decide(prompt.callId, 'deny', 'once')
      }
    }, 5)

    const result = await run({
      tools,
      approvals: { broker: policy.broker, interceptor: policy.interceptor },
      rounds: [
        call('w1', 'write_file', { path: 'notes.md', content: 'hello' }),
        text('understood, I will not write that file'),
      ],
    })
    clearInterval(watch)

    const tool = result.nodes.find(node => node.kind === 'tool')
    expect(tool?.state).toBe('error')
    // Denied, and the model was told in words it can act on.
    expect(JSON.stringify(result.requests[1])).toContain('did not permit')
    expect(result.nodes.at(-1)).toMatchObject({ kind: 'text' })
  }, 20_000)

  it('asks once when the user allows the whole workspace', async () => {
    const { policy, tools } = gate()
    const asked: string[] = []
    const watch = setInterval(() => {
      for (const prompt of policy.pending()) {
        if (asked.includes(prompt.callId)) continue
        asked.push(prompt.callId)
        void policy.decide(prompt.callId, 'allow', 'workspace')
      }
    }, 5)

    await run({
      tools,
      approvals: { broker: policy.broker, interceptor: policy.interceptor },
      rounds: [
        call('w1', 'write_file', { path: 'first.md', content: 'one' }),
        call('w2', 'write_file', { path: 'second.md', content: 'two' }),
        text('wrote both'),
      ],
    })
    clearInterval(watch)

    // The grant is what makes the second write silent; asking again would make
    // "allow for this workspace" meaningless.
    expect(asked).toHaveLength(1)
  }, 20_000)

  it('never asks permission to read output the run itself saved', async () => {
    // `read_tool_output` reads a file the HOST wrote, outside the workspace. A
    // gate that prompted for it would ask the user to approve the agent reading
    // its own truncated result.
    const { policy, tools } = gate()
    const store = createFileSpillStore()
    const huge = 'y'.repeat(60_000)
    tools.register(defineTool({
      name: 'dump', description: 'Return a lot.', parameters: { type: 'object' },
      execute: () => huge,
    }))

    const result = await run({
      tools,
      spillStore: store,
      bounds: { maxToolResultTokens: 200 },
      approvals: { broker: policy.broker, interceptor: policy.interceptor },
      rounds: [
        call('d1', 'dump', {}),
        call('s1', 'read_tool_output', { locator: 'spill:0', limit: 10 }),
        text('read it back'),
      ],
    })

    expect(policy.pending()).toEqual([])
    expect(result.nodes.filter(node => node.kind === 'tool')).toHaveLength(2)
  }, 20_000)
})

describe('control tools are host protocol', () => {
  it('keeps an interceptor from denying the deep-mode submission', async () => {
    // A host policy that refuses everything must not be able to refuse the one
    // call that ENDS the run: the agent would have no legal way to finish.
    const denyEverything = {
      name: 'deny-all',
      before: () => Promise.resolve({ kind: 'deny' as const, reason: 'policy refuses every call' }),
    }
    const result = await run({
      mode: 'deep',
      interceptors: [denyEverything],
      tools: toolsWith(defineTool({
        name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
        execute: () => 'contents',
      })),
      rounds: [
        call('w1', 'read_file', { path: 'a.ts' }),
        call('s1', 'submit_result', { summary: 'Done.', evidence: ['read a.ts'] }),
        text('final answer'),
      ],
    })

    const denied = result.nodes.filter(node => node.kind === 'tool' && node.state === 'error')
    expect(denied).toHaveLength(1)
    const end = result.events.find(event => event.type === 'agent-end')
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(true)
  }, 20_000)
})

describe('providers do not all behave alike', () => {
  it('survives a provider that repeats a tool-call id in one round', async () => {
    // Seen in the wild: the same id twice in one batch. History pairs results
    // to calls by id, so a duplicate either corrupts the pairing or throws —
    // and either way the next request is the one that breaks.
    const result = await run({
      tools: toolsWith(defineTool({
        name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
        execute: () => 'contents',
      })),
      rounds: [
        [
          {
            type: 'block-end', index: 0,
            block: { type: 'tool-call', id: ToolCallId('dup'), name: 'read_file', arguments: '{"path":"a"}' },
          },
          {
            type: 'block-end', index: 1,
            block: { type: 'tool-call', id: ToolCallId('dup'), name: 'read_file', arguments: '{"path":"b"}' },
          },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ],
        text('read both'),
      ],
    })

    // Whatever the loop decides to do with the duplicate, the run has to reach
    // an answer rather than dying on the provider's mistake.
    const end = result.events.find(event => event.type === 'agent-end')
    expect(end).toBeDefined()
    expect(result.nodes.some(node => node.kind === 'error')).toBe(false)
    // The first call is real work and still runs; only the repeat is dropped.
    expect(result.nodes.filter(node => node.kind === 'tool')).toHaveLength(1)
    // And the model is told which id it reused, rather than silently receiving
    // one result for two calls.
    expect(JSON.stringify(result.requests[1])).toContain('reused the tool-call id')
  })

  it('pairs a result to every call even when the model was cut off mid-batch', async () => {
    // `max-tokens` while emitting tool calls: the ones already parsed still
    // need results, or the next request carries a call nothing answered.
    const result = await run({
      tools: toolsWith(defineTool({
        name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
        execute: () => 'contents',
      })),
      rounds: [
        [
          {
            type: 'block-end', index: 0,
            block: { type: 'tool-call', id: ToolCallId('cut'), name: 'read_file', arguments: '{"path":"a"}' },
          },
          { type: 'finish', reason: { kind: 'max-tokens' } },
        ],
        text('answered anyway'),
      ],
    })

    const calls = result.events.filter(event => event.type === 'tool-call').length
    const results = result.events.filter(event => event.type === 'tool-result').length
    expect(results).toBe(calls)
  })

  it('sends no reasoning effort to a model that declares none', async () => {
    // Gemini rejects any value. A single agent must therefore be able to omit
    // it — which is why the sample runs the bounded loop rather than a session
    // for its single-agent modes.
    class NoEfforts extends StubAdapter {
      override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
        return Promise.resolve({ provider, id: model, name: model })
      }
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(options)
        yield* text('answered')
      }
    }
    const adapter = new NoEfforts()
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('go') })

    for await (const _event of runAgent({
      mode: 'basic', registry, history, config: { provider: 'test', model: 'no-efforts' },
      maxTurns: 2,
    })) { /* drain */ }

    expect(adapter.requests[0]).not.toHaveProperty('reasoningEffort')
  })

  it('keeps reasoning, commentary and the answer apart in the transcript', async () => {
    // A provider that narrates. The transcript has to separate what the model
    // thought, what it said on the way, and what it finally answered — the
    // three render differently and a reader cannot tell them apart otherwise.
    const result = await run({
      rounds: [[
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'weighing the options' },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighing the options' } },
        { type: 'text-delta', index: 1, text: 'Checking that now.', phase: 'commentary' },
        { type: 'block-end', index: 1, block: { type: 'text', text: 'Checking that now.', phase: 'commentary' } },
        { type: 'text-delta', index: 2, text: 'Here is the answer.', phase: 'final-answer' },
        { type: 'block-end', index: 2, block: { type: 'text', text: 'Here is the answer.', phase: 'final-answer' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]],
    })

    const kinds = result.nodes.map(node => node.kind)
    expect(kinds).toContain('reasoning')
    const said = result.nodes.filter(node => node.kind === 'text').map(node => node.text)
    expect(said).toEqual(['Checking that now.', 'Here is the answer.'])
  })
})
