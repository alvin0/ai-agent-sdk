/** Run with: node samples/multi-agent-offline/progress.ts — no credentials or network. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { ModelAdapter, ModelRegistry, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { createManagedAgentTeam, defineAgent, defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import type { TeamProgressEvent, ManagedAgentTeamOptions } from '@alvin0/ai-agent-sdk-core/agent'

function call(name: string, args: unknown): StreamChunk[] {
  return [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(crypto.randomUUID()),
    name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function answer(text: string): StreamChunk[] {
  return [{ type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
export class ProgressScript extends ModelAdapter {
  leadCalls = 0
  workerCalls = 0
  readonly leadRequests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const worker = (options.system ?? '').includes('You are managed worker')
    if (worker) {
      this.workerCalls++
      yield* this.workerCalls === 1 ? call('read_file', { path: 'notes/cache.txt' }) : answer('Cache verified.')
      return
    }
    this.leadRequests.push(options)
    this.leadCalls++
    if (this.leadCalls === 1) yield* call('spawn_agent', { task: 'Verify notes/cache.txt; return evidence.' })
    else if (this.leadCalls === 2) yield* call('progress_updates', { interval_ms: 20 })
    else yield* answer(this.workerCalls < 2 ? 'Waiting for the worker.' : 'Verified cache evidence.')
  }
}

export async function runProgressScenario(count = 2) {
  const adapter = new ProgressScript()
  const registry = new ModelRegistry()
  registry.registerAdapter(['offline-progress'], adapter)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reports: TeamProgressEvent[] = []
  const waitingCalls: number[] = []
  const waitingHistory: string[] = []
  const read = defineTool({ name: 'read_file', description: 'Read a fixture.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async () => { await gate; return 'Cache verified.' },
  })
  const options: ManagedAgentTeamOptions = { registry,
    lead: defineAgent({ id: 'lead', provider: 'offline-progress', model: 'scripted', mode: 'basic',
      instructions: 'Verify the evidence.', tools: [read], maxTurns: 8 }),
    progressUpdates: { minIntervalMs: 20, maxIntervalMs: 100, stalledIntervals: count + 2 },
    team: { onEvent: event => {
      if (event.type !== 'team-progress') return
      reports.push(event)
      if (event.phase !== 'report') return
      waitingCalls.push(adapter.leadCalls)
      waitingHistory.push(JSON.stringify(managed.lead.history.entries()))
      if (waitingCalls.length === count) release()
    } },
  }
  const managed = createManagedAgentTeam(options)
  // A referenced host deadline keeps this CLI alive; runtime progress timers themselves are unref'ed.
  const controller = new AbortController()
  const deadline = setTimeout(() => { release(); controller.abort(new Error('Offline scenario timed out')) }, 3000)
  try {
    const result = await managed.run('Delegate verification; while the worker runs, update me every 20 milliseconds.',
      { signal: controller.signal })
    assert.equal(reports.filter(event => event.phase === 'report').length, count)
    assert.equal(reports.at(-1)?.reason, 'settled')
    assert.equal(new Set(waitingCalls).size, 1, 'Reports must not wake the lead')
    assert.equal(new Set(waitingHistory).size, 1, 'Reports must not grow lead history')
    return { reports, leadCallsWhileReporting: waitingCalls[0], totalLeadCalls: adapter.leadCalls, text: result.text }
  } finally { clearTimeout(deadline); release(); await managed.dispose(); await managed.team.dispose() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runProgressScenario()
  console.log(JSON.stringify(result, null, 2))
}
