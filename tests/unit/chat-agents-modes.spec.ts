import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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

describe('research web sources', () => {
  it('delivers source links to the model using the redirected page as their base', async () => {
    const response = new Response('<title>Research</title><a href="../report?year=2026&amp;month=9">Dated report</a>')
    Object.defineProperty(response, 'url', { value: 'https://source.test/news/latest/' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    try {
      const result = await run({ tools: createSampleTools(join(home, 'sandbox')), rounds: [
        call('fetch-links', 'fetch_url', { url: 'https://source.test/start' }), text('Source link available.'),
      ] })
      const tool = result.nodes.find(node => node.kind === 'tool')
      expect(JSON.parse(tool!.output!)).toMatchObject({ links: [
        { url: 'https://source.test/news/report?year=2026&month=9', text: 'Dated report' },
      ] })
      expect(JSON.stringify(result.requests[1]?.messages)).toContain('https://source.test/news/report?year=2026&month=9')
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally { fetchMock.mockRestore() }
  })

  it('Stop aborts a pending fetch without making a finalization request', async () => {
    const controller = new AbortController()
    let fetchAborted = false
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { fetchAborted = true; reject(options.signal?.reason) }, { once: true })
      queueMicrotask(() => controller.abort(new Error('Stopped by user')))
    }))
    try {
      const result = await run({ signal: controller.signal, tools: createSampleTools(join(home, 'sandbox')), rounds: [
        call('fetch', 'fetch_url', { url: 'https://example.test/slow' }), text('Must not be called.'),
      ] })
      expect(fetchAborted).toBe(true)
      expect(result.requests).toHaveLength(1)
      expect(result.events.at(-1)).toMatchObject({ type: 'agent-end', outcome: { reason: { kind: 'aborted' } } })
    } finally { fetchMock.mockRestore() }
  })

  it('marks HTTP error pages as failed sources rather than successful evidence', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Access denied', { status: 403 }))
    try {
      const result = await run({ tools: createSampleTools(join(home, 'sandbox')), rounds: [
        call('fetch', 'fetch_url', { url: 'https://example.test/prices' }), text('Source unavailable; price unverified.'),
      ] })
      expect(result.nodes.find(node => node.kind === 'tool')).toMatchObject({ state: 'error' })
      expect(JSON.stringify(result.requests[1]?.messages)).toContain('HTTP 403')
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    } finally { fetchMock.mockRestore() }
  })

  it('cancels oversized source bodies and tells the model the text is truncated', async () => {
    const cancel = vi.fn()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('evidence '.repeat(30_000))) }, cancel,
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    try {
      const startedAt = Date.now()
      const result = await run({ tools: createSampleTools(join(home, 'sandbox')), rounds: [
        call('fetch', 'fetch_url', { url: 'https://example.test/report' }), text('Partial source inspected.'),
      ] })
      expect(cancel).toHaveBeenCalledOnce()
      expect(pulls).toBeLessThanOrEqual(2)
      const node = result.nodes.find(node => node.kind === 'tool')
      expect(node).toMatchObject({ state: 'ok' })
      const fetched = JSON.parse(node!.output!) as { fetchedAt: string; truncated: boolean }
      expect(fetched.truncated).toBe(true)
      expect(Date.parse(fetched.fetchedAt)).toBeGreaterThanOrEqual(startedAt)
      expect(Date.parse(fetched.fetchedAt)).toBeLessThanOrEqual(Date.now())
    } finally { fetchMock.mockRestore() }
  })
})

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
  readonly signal?: AbortSignal
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
    ...options.signal === undefined ? {} : { signal: options.signal },
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
  it('does not reopen completion when the sample publishes its final todo state', async () => {
    const result = await run({
      mode: 'deep', maxTurns: 8,
      tools: createSampleTools(join(home, 'sandbox')) as unknown as ToolRegistry,
      rounds: [
        call('submit', 'submit_result', { summary: 'Reconciled.', evidence: ['340 USD verified'] }),
        call('final-plan', 'write_todos', { items: [{ text: 'Reconcile revenue', status: 'done' }] }),
        text('The total is 340 USD. The plan is complete.'),
      ],
    })
    const end = result.events.find(e => e.type === 'agent-end')
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(true)
    expect(result.requests).toHaveLength(3)
  })

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
  it.each(['lead', 'worker'] as const)('Team-auto lets its %s finish past the old step ceiling', async actor => {
    const work = [
      ...Array.from({ length: 55 }, (_, i) => call(`page-${i}`, 'read_file', { path: `source-${i}.md` })),
      call('done', 'submit_result', { summary: 'Reviewed.', evidence: ['55 sources checked'] }),
      text('Final report: 55 sources checked.'),
    ]
    const adapter = new Scripted(actor === 'lead' ? work : [
      call('lead-done', 'submit_result', { summary: 'Ready.', evidence: ['request reviewed'] }), text('Ready.'), ...work,
    ])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const workerEvents: AgentRunEvent[] = []
    const handles = await startRun('Review the sources.', {
      registry, provider: 'test', model: 'scripted', effort: undefined, mode: 'team-dynamic',
      workspaceRoot: join(home, 'sandbox'), groupId: 'default', history: new History(),
      workspaceTools: toolsWith(defineTool({ name: 'read_file', description: 'Read evidence.',
        parameters: { type: 'object' }, execute: () => 'source evidence' })),
      userInput: createUserInputBroker(), agent: undefined, signal: new AbortController().signal,
    } as never, (_member, event) => { workerEvents.push(event) })
    try {
      const events: AgentRunEvent[] = []
      for await (const event of handles.events) events.push(event as AgentRunEvent)
      if (actor === 'worker') {
        await handles.managedTeam!.spawn({ name: 'researcher', task: 'Review all 55 sources.' })
        expect(await handles.managedTeam!.awaitWorker('researcher')).toMatchObject({
          text: 'Final report: 55 sources checked.', succeeded: true,
        })
      }
      const own = actor === 'lead' ? events : workerEvents
      expect(own.find(event => event.type === 'agent-start')).toMatchObject({ maxTurns: 'auto' })
      expect(own.find(event => event.type === 'agent-end')).toMatchObject({ outcome: {
        completed: true, steps: 57, text: 'Final report: 55 sources checked.',
      } })
    } finally { await handles.managedTeam?.dispose() }
  })

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

  it('puts the project’s AGENTS.md in front of the model', async () => {
    // Project conventions are always-on: an agent that never read them has
    // already broken them. Delivered as a context section rather than as system
    // prompt text, so an edit mid-run lands on the next round without
    // discarding the prompt cache.
    const sandbox = join(home, 'sandbox')
    mkdirSync(sandbox, { recursive: true })
    writeFileSync(join(sandbox, 'AGENTS.md'), '# House rules\nCommit messages use `fix:`.\n', 'utf8')
    try {
      const { requests } = await appRun(
        [call('r1', 'read_file', { path: 'a.ts' }), text('read it')],
        defineTool({
          name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
          execute: () => 'contents',
        }),
      )
      const sent = JSON.stringify(requests[0]?.messages)
      expect(sent).toContain('Commit messages use')
      // Named, so the model can tell one directory's rules from another's.
      expect(sent).toContain('AGENTS.md')
      // NOT in the system prompt: that is the cache prefix, and these files
      // change while a session runs.
      const system = requests[0]?.system
      expect(typeof system === 'string' ? system : JSON.stringify(system ?? ''))
        .not.toContain('Commit messages use')
      expect(system).toBeTypeOf('string')
    } finally { rmSync(join(sandbox, 'AGENTS.md'), { force: true }) }
  }, 20_000)

  it('picks up a nested AGENTS.md once a tool reads into that folder', async () => {
    // The sample's tools name their argument `path`, which is what the SDK's
    // default touch reader looks for. Wire a tool that names it otherwise and
    // this silently stops working, so the wiring is what is asserted.
    const sandbox = join(home, 'sandbox')
    mkdirSync(join(sandbox, 'pkg'), { recursive: true })
    writeFileSync(join(sandbox, 'pkg', 'AGENTS.md'), 'Inside pkg: no default exports.\n', 'utf8')
    try {
      const { requests } = await appRun(
        [call('r1', 'read_file', { path: 'pkg/handler.ts' }), text('read it')],
        defineTool({
          name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
          execute: () => 'contents',
        }),
      )
      // Round 1 could not know about it; round 2 follows the read.
      expect(JSON.stringify(requests[0]?.messages)).not.toContain('no default exports')
      expect(JSON.stringify(requests[1]?.messages)).toContain('no default exports')
    } finally { rmSync(join(sandbox, 'pkg'), { recursive: true, force: true }) }
  }, 20_000)

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

  it('keeps a final report after the sample consumes all work steps', async () => {
    const { requests, events } = await appRun([
      ...Array.from({ length: 32 }, (_, index) => call(`read-${index}`, 'read_file', { path: `source-${index}.md` })),
      text('Report: sources compared; pending items remain unverified.'),
    ], defineTool({
      name: 'read_file', description: 'Read evidence.', parameters: { type: 'object' },
      execute: () => 'source evidence',
    }))
    const end = events.find(event => event.type === 'agent-end')
    expect(end?.type === 'agent-end' && end.outcome.text).toContain('Report: sources compared')
    expect(requests).toHaveLength(33)
    expect(requests.at(-1)?.toolChoice).toBe('none')
    expect(requests[0]?.system).toContain('reconcile the plan')
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

  it('narrows a session grant to the rule the user picked', async () => {
    // The prompt offers `git diff *` before `git *`. Picking the narrow rule
    // has to actually narrow: the next diff is silent, and a push is not.
    const { policy, tools } = gate()
    const asked: string[] = []
    const watch = setInterval(() => {
      for (const prompt of policy.pending()) {
        if (asked.includes(prompt.summary)) continue
        asked.push(prompt.summary)
        void policy.decide(prompt.callId, 'allow', 'session', 'run_command:prefix:git diff')
      }
    }, 5)

    await run({
      tools,
      approvals: { broker: policy.broker, interceptor: policy.interceptor },
      rounds: [
        call('c1', 'run_command', { command: 'git diff --stat' }),
        call('c2', 'run_command', { command: 'git diff --cached' }),
        call('c3', 'run_command', { command: 'git push --force' }),
        text('ran them'),
      ],
    })
    clearInterval(watch)

    // The second diff rode the grant; the push had to be asked about, which is
    // the whole reason the narrow rule exists.
    expect(asked).toEqual(['git diff --stat', 'git push --force'])
  }, 20_000)

  it('refuses to store a rule the prompt never offered', async () => {
    // The rule key arrives from the client. A key it invents — `run_command`,
    // covering every command there is — must not become a grant just because
    // it was asked for; the policy falls back to the narrowest rule offered.
    const { policy, tools } = gate()
    const asked: string[] = []
    const watch = setInterval(() => {
      for (const prompt of policy.pending()) {
        if (asked.includes(prompt.summary)) continue
        asked.push(prompt.summary)
        void policy.decide(prompt.callId, 'allow', 'session', 'run_command')
      }
    }, 5)

    await run({
      tools,
      approvals: { broker: policy.broker, interceptor: policy.interceptor },
      rounds: [
        call('c1', 'run_command', { command: 'git diff --stat' }),
        call('c2', 'run_command', { command: 'ls -la' }),
        text('ran them'),
      ],
    })
    clearInterval(watch)

    expect(asked).toEqual(['git diff --stat', 'ls -la'])
  }, 20_000)

  it('keeps asking about a command no rule can describe', async () => {
    // `&&` makes the prefix a label rather than a promise: "every `git diff …`
    // command" would be printed over a line that also deletes the workspace.
    // The prompt offers nothing, so `session` remembers nothing.
    const { policy, tools } = gate()
    const asked: string[] = []
    const watch = setInterval(() => {
      for (const prompt of policy.pending()) {
        if (asked.includes(prompt.summary)) continue
        asked.push(prompt.summary)
        expect(prompt.rules).toEqual([])
        void policy.decide(prompt.callId, 'allow', 'workspace')
      }
    }, 5)

    await run({
      tools,
      approvals: { broker: policy.broker, interceptor: policy.interceptor },
      rounds: [
        call('c1', 'run_command', { command: 'git diff && echo one' }),
        call('c2', 'run_command', { command: 'git diff && echo two' }),
        text('ran them'),
      ],
    })
    clearInterval(watch)

    expect(asked).toHaveLength(2)
  }, 20_000)

  it('will not remember a destructive line, whatever scope is asked for', async () => {
    // `rm -rf ~` is not a family of calls to be permitted for a project. The
    // prompt offers no rule, so `workspace` stores nothing and the next one is
    // asked about again — the opposite of what a scope normally does.
    const { policy, tools } = gate()
    const asked: string[] = []
    const watch = setInterval(() => {
      for (const prompt of policy.pending()) {
        if (asked.includes(prompt.summary)) continue
        asked.push(prompt.summary)
        expect(prompt.rules).toEqual([])
        expect(prompt.hazards?.[0]?.severity).toBe('critical')
        void policy.decide(prompt.callId, 'allow', 'workspace')
      }
    }, 5)

    await run({
      tools,
      approvals: { broker: policy.broker, interceptor: policy.interceptor },
      rounds: [
        call('c1', 'run_command', { command: 'rm -rf /tmp/../etc/hosts' }),
        call('c2', 'run_command', { command: 'rm -rf /etc/hosts' }),
        text('ran them'),
      ],
    })
    clearInterval(watch)

    expect(asked).toHaveLength(2)
  }, 20_000)

  it('can answer a prompt another interceptor parked', async () => {
    // The policy only has a card for calls IT asked about. A second
    // interceptor — a host guard, a plugin — parks calls on the same broker,
    // and those used to be unanswerable: `decide` found no prompt, reported
    // nothing released, and the run waited on a card the user had clicked.
    const { policy, tools } = gate()
    const askEverything = {
      name: 'ask-all',
      before: () => Promise.resolve({ kind: 'ask' as const, reason: 'the host guard wants a look' }),
    }
    const answered: string[] = []
    const watch = setInterval(() => {
      for (const request of policy.broker.pending()) {
        if (answered.includes(request.approvalRequestId)) continue
        answered.push(request.approvalRequestId)
        void policy.decide(request.approvalRequestId, 'allow', 'once')
      }
    }, 5)

    const result = await run({
      tools,
      approvals: { broker: policy.broker, interceptor: askEverything },
      rounds: [
        call('r1', 'read_file', { path: 'nothing.md' }),
        text('read it'),
      ],
    })
    clearInterval(watch)

    expect(answered).toHaveLength(1)
    // Released, not stranded: the call reached the tool and came back.
    expect(result.nodes.filter(node => node.kind === 'tool')).toHaveLength(1)
    // And nothing was remembered, because there was no rule to remember.
    expect(policy.pending()).toEqual([])
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

  it.each([undefined, 'researcher'])('settles late block phases for %s without duplicating text', async member => {
    const adapter = new Scripted([[
      { type: 'text-delta', index: 17, text: 'Checking.' },
      { type: 'block-end', index: 17, block: { type: 'text', text: 'Checking.', phase: 'commentary' } },
      // Sparse, non-monotonic index and no deltas: the block is authoritative.
      { type: 'block-end', index: 3, block: { type: 'text', text: 'Verified report.', phase: 'final-answer' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const project = new EventProjector()
    const wire = []
    for await (const event of runAgent({
      mode: 'basic', registry, history: new History(), config: { provider: 'test', model: 'scripted' },
    })) wire.push(...(member === undefined ? project.forLead(event) : project.forMember(member, event)))
    const texts = [...project.flush(), ...project.settled()].filter(n => n.kind === 'text')
    expect(texts).toMatchObject([
      { text: 'Checking.', phase: 'commentary' }, { text: 'Verified report.', phase: 'final-answer' },
    ])
    expect(texts.every(n => n.member === member)).toBe(true)
    expect(wire.some(e => e.t === 'text-end' && e.phase === 'final-answer' && e.text === 'Verified report.')).toBe(true)
  })

  it.each(['error', 'aborted', 'max-tokens'] as const)('keeps block-only partial reports on %s for lead and workers', async kind => {
    const finish: StreamChunk = kind === 'max-tokens'
      ? { type: 'finish', reason: { kind } }
      : { type: 'finish', reason: { kind, failure: { code: 'INTERRUPTED', message: 'stream interrupted' } } }
    for (const member of [undefined, 'researcher']) {
      const adapter = new Scripted([[
        ...(kind === 'aborted' ? [{ type: 'block-start', index: 2, blockType: 'text' } as StreamChunk] : []),
        { type: 'block-end', index: 9, block: { type: 'text', text: 'Evidence gathered; verification pending.', phase: 'final-answer' } },
        finish,
      ]])
      const registry = new ModelRegistry()
      registry.registerAdapter(['test'], adapter)
      const project = new EventProjector()
      const wire = []
      for await (const event of runAgent({ mode: 'basic', registry, history: new History(),
        config: { provider: 'test', model: 'scripted' },
      })) wire.push(...(member === undefined ? project.forLead(event) : project.forMember(member, event)))
      const settled = [...project.flush(), ...project.settled()]
      const texts = settled.filter(n => n.kind === 'text')
      expect(texts).toHaveLength(1)
      expect(texts[0]).toMatchObject({ text: 'Evidence gathered; verification pending.', incomplete: true })
      expect(texts[0]?.id).toMatch(/\.t9$/)
      expect(texts[0]?.member).toBe(member)
      expect(wire.some(e => e.t === 'text-end' && e.incomplete === true)).toBe(true)
      if (member !== undefined) {
        expect(wire).toContainEqual(expect.objectContaining({ t: 'notice', level: 'warn', member,
          message: expect.stringContaining("Worker 'researcher' did not complete its task"),
        }))
        expect(settled).toContainEqual(expect.objectContaining({ kind: 'notice', member, level: 'warn' }))
        expect(wire.some(e => e.t === 'run-end')).toBe(false)
      }
    }
  })

  it.each(['reserve', 'hard-limit'] as const)('explains the actual worker token stop (%s)', async kind => {
    const adapter = new Scripted([[
      ...call('read', 'read_file', { path: 'source.md' }).slice(0, -1),
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ], text('Partial findings; verification remains pending.')])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const project = new EventProjector()
    const wire = []
    for await (const event of runAgent({ mode: 'basic', registry, history: new History(),
      config: { provider: 'test', model: 'scripted' }, maxTurns: 'auto',
      tools: toolsWith(defineTool({ name: 'read_file', description: 'Read.', parameters: { type: 'object' }, execute: () => 'evidence' })),
      bounds: { maxTotalTokens: kind === 'reserve' ? 20 : 12, finalReportReserveTokens: 10, onExhausted: 'continue' },
    })) wire.push(...project.forMember('banking', event))
    const message = kind === 'reserve' ? 'research stopped to reserve token capacity' : 'hard cumulative token limit reached'
    expect(wire).toContainEqual(expect.objectContaining({ t: 'notice', member: 'banking', message: expect.stringContaining(message) }))
    expect([...project.flush(), ...project.settled()]).toContainEqual(expect.objectContaining({
      kind: 'notice', member: 'banking', message: expect.stringContaining(message),
    }))
  })

  it('does not stream text stragglers or shift canonical block indexes', async () => {
    const result = await run({ rounds: [[
      { type: 'block-end', index: 7, block: { type: 'reasoning', text: 'Checked evidence' } },
      { type: 'text-delta', index: 7, text: 'ignored straggler' },
      { type: 'text-delta', index: 21, text: 'Draft' },
      { type: 'block-end', index: 21, block: { type: 'text', text: 'Canonical answer', phase: 'final-answer' } },
      { type: 'text-delta', index: 21, text: 'ignored suffix' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]] })
    expect(result.nodes.filter(n => n.kind === 'text')).toMatchObject([{ text: 'Canonical answer' }])
    expect(result.events.filter(e => e.type === 'text-delta')).toMatchObject([{ index: 21, text: 'Draft' }])
    expect(result.events.filter(e => e.type === 'text-end')).toMatchObject([{ index: 21, text: 'Canonical answer' }])
  })
})
