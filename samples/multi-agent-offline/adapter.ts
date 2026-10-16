import { ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'

export type TeamMode = 'delegation' | 'collaboration'

export const NOTES = {
  latency: 'The cache reduced median latency from 80 ms to 40 ms.',
  errors: 'The error rate stayed at 1% before and after the cache change.',
} as const

function answer(text: string): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function calls(items: readonly { name: string; args: unknown }[]): StreamChunk[] {
  return [
    ...items.map(({ name, args }, index): StreamChunk => ({
      type: 'block-end', index, block: { type: 'tool-call',
        id: ToolCallId(crypto.randomUUID()), name, arguments: JSON.stringify(args) },
    })),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function call(name: string, args: unknown): StreamChunk[] { return calls([{ name, args }]) }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Read the actual board response rather than assuming a claim's revision. */
function taskRevision(options: GenerateOptions): number {
  const result = options.messages.flatMap(message => message.content)
    .filter(block => block.type === 'tool-result').at(-1)
  const text = result?.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('Missing board response')
  const value: unknown = JSON.parse(text.text)
  const task = Array.isArray(value) ? value[0] : value
  if (task === null || typeof task !== 'object' || !('revision' in task)
    || typeof task.revision !== 'number') throw new Error('Missing task revision')
  return task.revision
}

/** A local protocol script, not a model or a performance simulation. No network calls. */
export class OfflineTeamAdapter extends ModelAdapter {
  readonly requests: { actor: string; options: GenerateOptions }[] = []
  private readonly rounds = new Map<string, number>()
  private readonly mode: TeamMode
  private readonly leadYield = deferred()
  private readonly peerReady = deferred()
  private readonly peerDelivered = deferred()

  constructor(mode: TeamMode) { super(); this.mode = mode }

  /** The offline host releases evidence only after observing a real provisional yield. */
  releaseWorkers(): void { this.leadYield.resolve() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const actor = /You are managed worker '([^']+)'/.exec(options.system ?? '')?.[1] ?? 'lead'
    const round = (this.rounds.get(actor) ?? 0) + 1
    this.rounds.set(actor, round)
    this.requests.push({ actor, options })
    this.checkResults(options)
    await this.coordinate(actor, round)
    const chunks = actor === 'lead' ? this.lead(round, options) : this.worker(actor, round, options)
    for (const chunk of chunks) {
      this.checkTool(chunk, options)
      if (chunk.type === 'finish') {
        // Synthetic counters demonstrate accounting, not measured model usage.
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      }
      yield chunk
    }
  }

  private checkResults(options: GenerateOptions): void {
    for (const block of options.messages.flatMap(message => message.content)) {
      if (block.type === 'tool-result' && block.isError) throw new Error('Offline tool call failed')
    }
  }

  private checkTool(chunk: StreamChunk, options: GenerateOptions): void {
    if (chunk.type !== 'block-end' || chunk.block.type !== 'tool-call') return
    const name = chunk.block.name
    if (!options.tools?.some(tool => tool.name === name)) {
      throw new Error(`Script requested an unavailable tool: ${name}`)
    }
  }

  private async coordinate(actor: string, round: number): Promise<void> {
    if (actor !== 'lead' && this.mode === 'delegation' && round === 2) {
      await this.leadYield.promise
    }
    if (this.mode === 'collaboration') await this.coordinatePeers(actor, round)
  }

  private async coordinatePeers(actor: string, round: number): Promise<void> {
    // Keep the recipient live until the one peer send is accepted. No sleeps or reply loop.
    if (actor === 'worker_2') this.peerReady.resolve()
    if (actor === 'worker_1' && round === 2) await this.peerReady.promise
    if (actor === 'worker_1' && round === 3) this.peerDelivered.resolve()
    if (actor === 'worker_2' && round === 2) await this.peerDelivered.promise
  }

  private lead(round: number, options: GenerateOptions): StreamChunk[] {
    const collaboration = this.mode === 'collaboration'
    // Plain delegation starts with both spawn verbs. Require the remaining
    // controls once real spawn call/result pairs establish successful setup.
    const blocks = options.messages.flatMap(message => message.content)
    const spawns = new Set(blocks.flatMap(block =>
      block.type === 'tool-call' && block.name === 'spawn_agent' ? [block.id] : []))
    const spawned = blocks.some(block => block.type === 'tool-result'
      && !block.isError && spawns.has(block.toolCallId))
    if (collaboration || spawned) {
      for (const name of ['send_input', 'wait_agents', 'close_agent', 'get_agent_result']) {
        if (!options.tools?.some(tool => tool.name === name)) {
          throw new Error(`Missing disclosed team control: ${name}`)
        }
      }
    }
    if (collaboration && round === 1) return calls(Object.keys(NOTES).map(id => ({
      name: 'task_create', args: { id, title: `Check ${id} evidence for the cache rollout.` },
    })))
    const step = round - Number(collaboration)
    if (step === 1) return calls(Object.keys(NOTES).map(id => ({
      name: 'spawn_agent', args: {
        task: `Read note '${id}' with read_note. Return its exact finding; do not edit files.`
          + (collaboration ? ` Claim board task '${id}' and complete it with the finding.` : ''),
        context: 'fresh',
      },
    })))
    if (step === 2) return collaboration
      ? call('wait_agents', {})
      : answer('Waiting for worker reports.') // provisional text; automatic push resumes synthesis
    if (collaboration && step === 3) return call('task_list', { ids: Object.keys(NOTES) })
    const evidence = JSON.stringify(options.messages)
    if (!Object.values(NOTES).every(note => evidence.includes(note))) {
      throw new Error('Lead cannot synthesize without both worker findings')
    }
    return answer('Cache rollout: median latency halved (80 ms → 40 ms); error rate stayed at 1%.')
  }

  private worker(actor: string, round: number, options: GenerateOptions): StreamChunk[] {
    const id = actor === 'worker_1' ? 'latency' : 'errors'
    if (round === 1) return call('read_note', { id })
    if (!JSON.stringify(options.messages).includes(NOTES[id])) throw new Error('Missing source evidence')
    if (this.mode === 'collaboration') {
      if (actor === 'worker_1' && round === 2) return call('send_input', {
        target: 'worker_2', message: `Latency check: ${NOTES.latency} `
          + 'Verify errors independently; publish to your board task.',
      })
      const step = round - Number(actor === 'worker_1')
      if (step === 2) return call('task_list', { ids: [id] })
      if (step === 3) return call('task_update', { id, expectedRevision: taskRevision(options), action: 'claim' })
      if (step === 4) return call('task_update', {
        id, expectedRevision: taskRevision(options), action: 'complete',
        notes: 'Verified against the local read_note source.', result: NOTES[id],
      })
    }
    return answer(NOTES[id])
  }
}
