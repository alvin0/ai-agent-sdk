/** Public-entrypoint orchestration benchmark; controlled adapters, no provider credentials. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { setImmediate as checkpoint } from 'node:timers/promises'
import type * as Core from '@alvin0/ai-agent-sdk-core'
import type * as Agent from '@alvin0/ai-agent-sdk-core/agent'

export interface SDK { core: typeof Core; agent: typeof Agent }
const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
export const CASES = [
  'host-controls-worker-tools', 'host-controls-lead-turns', 'silent-worker-completion', 'required-worker-text-policy',
  'late-dependency-result', 'closed-multi-dependency-result', 'concurrent-write-admission',
  'equivalent-write-scope', 'escaping-write-scope', 'failed-spawn-cleanup',
  'dispose-during-setup', 'dispose-pending-chain', 'abort-await-worker',
  'abort-when-quiet', 'quiet-waits-for-report', 'independent-parallel-control',
  'ordered-write-control', 'failed-dependency-control',
  'dependency-completes-during-setup', 'dependency-closes-during-setup',
  'dependency-name-reuse', 'fork-scoped-history-limit', 'host-spawn-setup-timeout',
  'quiet-waits-for-setup', 'close-coalesces-instance', 'failed-dependency-handoff-no-dispatch',
  'oversized-worker-notification', 'closed-dependency-full-read', 'wake-budget-failure-truth', 'steer-interrupts-automatic-hold', 'close-bounds-host-cancellation', 'unicode-dependency-pagination', 'aborted-setup-rejection-observed',
] as const
export type CaseId = typeof CASES[number]
export interface CaseResult { id: CaseId; passed: boolean; observed: unknown; elapsedMs: number }

function fixture(sdk: SDK, extra: Partial<Agent.ManagedAgentTeamOptions> = {}) {
  class Controlled extends sdk.core.ModelAdapter {
    readonly requests = new Map<string, Core.GenerateOptions[]>()
    private readonly starts = new Map<string, ReturnType<typeof deferred>>()
    private readonly finishes = new Map<string, ReturnType<typeof deferred>>()
    finish(name: string) { this.gate(this.finishes, name).release() }
    started(name: string) { return this.gate(this.starts, name).promise }
    rearm(name: string) { this.starts.delete(name); this.finishes.delete(name) }
    private gate(map: Map<string, ReturnType<typeof deferred>>, name: string) {
      let gate = map.get(name)
      if (!gate) { gate = deferred(); map.set(name, gate) }
      return gate
    }
    override async resolveModel(provider: string, id: string): Promise<Core.ResolvedModelInfo> {
      const effort = sdk.core.ReasoningEffortId('medium')
      return { provider, id, name: id, reasoning: { efforts: [{ id: effort, name: 'medium' }] } }
    }
    override async *stream(options: Core.GenerateOptions): AsyncIterable<Core.StreamChunk> {
      const name = /dynamically assigned worker '([^']+)'/.exec(options.system ?? '')?.[1] ?? 'lead'
      const requests = this.requests.get(name) ?? []
      requests.push(options); this.requests.set(name, requests)
      this.gate(this.starts, name).release()
      if (name === 'lead' && requests.length === 1 && JSON.stringify(options.messages).includes('Commission detached work.')) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: sdk.core.ToolCallId('detached'), name: 'spawn_agent', arguments: JSON.stringify({ name: 'detached', task: 'Do tool-only work.' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (name !== 'lead') {
        const gate = this.gate(this.finishes, name)
        await new Promise<void>(resolve => {
          const abort = () => resolve()
          if (options.signal?.aborted) resolve()
          else options.signal?.addEventListener('abort', abort, { once: true })
          void gate.promise.then(() => { options.signal?.removeEventListener('abort', abort); resolve() })
        })
      }
      options.signal?.throwIfAborted()
      if (name === 'consumer' && requests.length === 1 && JSON.stringify(options.messages).includes('Read Unicode dependency pages.')) {
        for (const [index, offset] of [0, 1, 3, 5, 6, 7, 2].entries()) {
          yield { type: 'block-end', index, block: { type: 'tool-call', id: sdk.core.ToolCallId(`unicode-${index}`), name: 'read_dependency_result', arguments: JSON.stringify({ name: 'unicode', offset }) } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (name === 'consumer' && requests.length === 1 && JSON.stringify(options.messages).includes('Read all original large evidence.')) {
        for (const [index, args] of [{ name: 'large', offset: 34900 }, { name: 'uncommissioned', offset: 0 }, { name: 'large', offset: 79000 }].entries()) {
          yield { type: 'block-end', index, block: { type: 'tool-call', id: sdk.core.ToolCallId(`read-${index}`), name: 'read_dependency_result', arguments: JSON.stringify(args) } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (name === 'silent') {
        if (requests.length === 1) {
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: sdk.core.ToolCallId('receipt'), name: 'record_receipt', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const text = name === 'unicode' ? '�😀𐍈中é�' : name === 'large' ? 'HEAD_SOURCE ' + 'x'.repeat(35000) + ' MIDDLE_SOURCE ' + 'x'.repeat(45000) + ' TAIL_SOURCE' : `${name} evidence: source-${name}, observed=120, baseline=100, change=20%; no mutation authority.`
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new Controlled()
  const registry = new sdk.core.ModelRegistry()
  registry.registerAdapter(['fixture'], adapter)
  const definition = sdk.agent.defineAgent({ id: 'lead', provider: 'fixture', model: 'controlled',
    instructions: 'Complete only your assigned task from supplied evidence.', mode: 'basic', maxTurns: 4 })
  const managed = sdk.agent.createManagedAgentTeam({ registry, lead: definition, maxWorkers: 8,
    holdWaitMs: 50, closeTimeoutMs: 1000, workerTimeoutMs: 5000, ...extra })
  const body = (name: string) => JSON.stringify(adapter.requests.get(name)?.[0]?.messages ?? [])
  const finish = async (name: string) => { adapter.finish(name); return managed.awaitWorker(name, { timeoutMs: 2000 }) }
  const cleanup = async () => { await managed.dispose(); await managed.team.dispose() }
  return { adapter, managed, definition, body, finish, cleanup }
}

export async function runCase(sdk: SDK, id: CaseId): Promise<CaseResult> {
  const started = performance.now()
  let passed = false, observed: unknown
  if (id === 'host-controls-worker-tools') {
    const offered: Record<string, string[]> = {}
    const advertised: Record<string, string[]> = {}
    const teamVerbs = ['list_agents', 'send_message', 'followup_task', 'wait_agents']
    for (const access of ['full', 'reporting', false] as const) {
      const f = fixture(sdk, { workerTeamTools: access })
      try {
        await f.managed.spawn({ name: 'peer', task: 'Follow the host protocol.' }); await f.adapter.started('peer')
        const request = f.adapter.requests.get('peer')?.[0]
        offered[String(access)] = (request?.tools ?? []).map(t => t.name)
        advertised[String(access)] = teamVerbs.filter(name => request?.system?.includes(name))
      } finally { await f.cleanup() }
    }
    passed = offered.full!.includes('wait_agents') && offered.full!.includes('followup_task')
      && !offered.false!.includes('send_message') && !offered.false!.includes('wait_agents')
      && teamVerbs.every(name => !offered.false!.includes(name)) && advertised.false!.length === 0
      && advertised.reporting!.join(',') === 'list_agents,send_message'
      && offered.reporting!.includes('list_agents') && offered.reporting!.includes('send_message')
      && !offered.reporting!.includes('followup_task') && !offered.reporting!.includes('wait_agents')
      && advertised.full!.length === teamVerbs.length
    observed = { offered, advertised }
  } else if (id === 'host-controls-lead-turns') {
    const f = fixture(sdk, { autoLeadCoordination: false, holdWaitMs: 1000 })
    let returned = false
    const run = f.managed.run('Commission detached work.').then(() => { returned = true })
    try {
      await f.adapter.started('detached')
      await new Promise<void>(resolve => setTimeout(resolve, 60))
      const returnedWhileWorkerRunning = returned
      const callsBeforeCompletion = f.adapter.requests.get('lead')?.length ?? 0
      await f.finish('detached'); await run; await f.managed.whenQuiet()
      const callsAfterCompletion = f.adapter.requests.get('lead')?.length ?? 0
      passed = returnedWhileWorkerRunning && callsBeforeCompletion === 2 && callsAfterCompletion === 2
      observed = { returnedWhileWorkerRunning, callsBeforeCompletion, callsAfterCompletion }
    } finally { f.adapter.finish('detached'); await run; await f.cleanup() }
  } else if (id === 'silent-worker-completion' || id === 'required-worker-text-policy') {
    let receipts = 0
    const receipt = sdk.agent.defineTool({ name: 'record_receipt', description: 'Record successful tool-only work.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { receipts++; return { recorded: true } } })
    const f = fixture(sdk, { requireWorkerText: id === 'required-worker-text-policy', workerSessionOptions: { tools: [receipt] } })
    try {
      await f.managed.spawn({ name: 'silent', task: 'Finish without a textual answer.' }); await f.adapter.started('silent')
      await f.finish('silent')
      const worker = f.managed.workers().find(w => w.name === 'silent')!
      const expected = id === 'silent-worker-completion' ? 'completed' : 'failed'
      passed = receipts === 1 && worker.status === expected && (expected === 'completed'
        ? worker.result?.text === '' && worker.result.succeeded === false
        : worker.result === undefined && worker.error === 'it produced no answer')
      observed = { receipts, status: worker.status, text: worker.result?.text, succeeded: worker.result?.succeeded, error: worker.error, expected }
    } finally { await f.cleanup() }
  } else if (id === 'aborted-setup-rejection-observed') {
    const controller = new AbortController(), unhandled: string[] = []
    const observe = (error: unknown) => { unhandled.push(String(error)) }
    process.on('unhandledRejection', observe)
    const f = fixture(sdk, { workerFactory: () => { controller.abort(new Error('owner cancelled setup')); throw new Error('factory rejected at cancellation boundary') } })
    try {
      const rejected = await f.managed.spawn({ name: 'never_started', task: 'Read evidence.' }, controller.signal).then(() => false, () => true)
      await checkpoint(); await checkpoint()
      passed = rejected && unhandled.length === 0 && f.managed.workers().length === 0
      observed = { rejected, unhandled, retainedWorkers: f.managed.workers().length }
    } finally { process.removeListener('unhandledRejection', observe); await f.cleanup() }
  } else if (id === 'unicode-dependency-pagination') {
    const f = fixture(sdk, { maxDependencyReportBytes: 4 })
    try {
      await f.managed.spawn({ name: 'unicode', task: 'Return Unicode evidence.' }); await f.adapter.started('unicode'); await f.finish('unicode')
      await f.managed.spawn({ name: 'consumer', task: 'Read Unicode dependency pages.', dependsOn: ['unicode'] }); await f.adapter.started('consumer'); await f.finish('consumer')
      const pages: { text: string; nextOffset: number | null }[] = []
      let invalidBoundaryDenied = false
      const visit = (value: unknown): void => {
        if (typeof value === 'string') {
          if (value.includes('valid character boundary')) invalidBoundaryDenied = true
          if (value.startsWith('{')) { try { visit(JSON.parse(value)) } catch { /* ordinary text */ } }
        } else if (value && typeof value === 'object') {
          const item = value as { name?: unknown; text?: unknown; nextOffset?: unknown }
          if (item.name === 'unicode' && typeof item.text === 'string' && Object.hasOwn(value, 'nextOffset')) pages.push({ text: item.text, nextOffset: item.nextOffset as number | null })
          for (const entry of Object.values(value)) visit(entry)
        }
      }
      visit(f.adapter.requests.get('consumer')?.at(-1)?.messages)
      passed = JSON.stringify(pages) === JSON.stringify([{ text: '�', nextOffset: 1 }, { text: '😀', nextOffset: 3 }, { text: '𐍈', nextOffset: 5 }, { text: '中', nextOffset: 6 }, { text: 'é', nextOffset: 7 }, { text: '�', nextOffset: null }]) && invalidBoundaryDenied
      observed = { pages, invalidBoundaryDenied }
    } finally { await f.cleanup() }
  } else if (id === 'close-bounds-host-cancellation') {
    const entered = deferred(), released = deferred()
    class SlowCancellation extends sdk.agent.AgentTeam {
      override async cancel(name: string, reason?: unknown) { await super.cancel(name, reason); if (name === 'held') { entered.release(); await released.promise } }
    }
    const f = fixture(sdk, { team: new SlowCancellation(), closeTimeoutMs: 10 })
    try {
      await f.managed.spawn({ name: 'held', task: 'Read evidence.' }); await f.adapter.started('held')
      let closed = false
      const closing = f.managed.closeWorker('held').then(() => { closed = true })
      await entered.promise; await new Promise<void>(resolve => setTimeout(resolve, 40))
      const completedBeforeHostReleased = closed
      released.release(); await closing
      passed = completedBeforeHostReleased; observed = { completedBeforeHostReleased, closeTimeoutMs: 10 }
    } finally { released.release(); await f.cleanup() }
  } else if (id === 'wake-budget-failure-truth') {
    const registry = new sdk.core.ModelRegistry()
    class Limited extends sdk.core.ModelAdapter {
      override async *stream(): AsyncIterable<Core.StreamChunk> {
        yield { type: 'text-delta', index: 0, text: 'Partial evidence only.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Partial evidence only.' } }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      }
    }
    registry.registerAdapter(['fixture'], new Limited())
    const team = new sdk.agent.AgentTeam()
    const agent = sdk.agent.defineAgent({ id: 'peer', provider: 'fixture', model: 'limited', instructions: 'Read evidence.', mode: 'basic' })
    agent.createSession({ registry, team: { team, name: 'peer' } }); agent.createSession({ registry, team: { team, name: 'sender' } })
    try {
      await team.sendMessage({ from: 'sender', target: 'peer', message: 'Read evidence.', delivery: 'wakeup' })
      await team.whenIdle('peer')
      const member = team.members()[0]!
      passed = member.status === 'failed' && member.outcome?.kind === 'failed'
      observed = { status: member.status, outcome: member.outcome }
    } finally { await team.dispose() }
  } else if (id === 'oversized-worker-notification' || id === 'closed-dependency-full-read') {
    const f = fixture(sdk)
    try {
      await f.managed.spawn({ name: 'large', task: 'Read large evidence.' }); await f.adapter.started('large'); await f.finish('large')
      if (id === 'oversized-worker-notification') {
        const message = JSON.stringify(f.managed.team.messages().filter(m => m.sender === 'large'))
        passed = message.includes('HEAD_SOURCE') && message.includes('TAIL_SOURCE') && message.includes('truncated')
        observed = { reports: f.managed.team.messages().filter(m => m.sender === 'large').length, head: message.includes('HEAD_SOURCE'), tail: message.includes('TAIL_SOURCE') }
      } else {
        await f.managed.spawn({ name: 'slow', task: 'Read slow evidence.' }); await f.adapter.started('slow')
        await f.managed.spawn({ name: 'consumer', task: 'Read all original large evidence.', dependsOn: ['large', 'slow'] })
        await f.managed.closeWorker('large'); await f.finish('slow'); await f.adapter.started('consumer')
        const tool = f.adapter.requests.get('consumer')?.[0]?.tools?.find(tool => tool.name === 'read_dependency_result')
        passed = !!tool && f.body('consumer').includes('TAIL_SOURCE') && f.body('consumer').includes('read_dependency_result')
        observed = { scopedFullReadTool: !!tool, tailInHandoff: f.body('consumer').includes('TAIL_SOURCE') }
        await f.finish('consumer')
        const modelVisible = JSON.stringify(f.adapter.requests.get('consumer')?.at(-1)?.messages)
        const fullPageRecovered = modelVisible.includes('MIDDLE_SOURCE') && modelVisible.includes('TAIL_SOURCE')
        const unauthorizedDenied = modelVisible.includes('not commissioned')
        passed = passed && fullPageRecovered && unauthorizedDenied
        observed = { scopedFullReadTool: !!tool, fullPageRecovered, unauthorizedDenied, modelCalls: f.adapter.requests.get('consumer')?.length }
      }
    } finally { await f.cleanup() }
  } else if (id === 'steer-interrupts-automatic-hold') {
    const entered = deferred(), released = deferred()
    let first = true
    const f = fixture(sdk, { holdWaitMs: 1000, leadSessionOptions: { hooks: { async onTurnEnd() {
      if (first) { first = false; entered.release(); await released.promise }
    } } } })
    try {
      await f.managed.spawn({ name: 'held', task: 'Read evidence.' }); await f.adapter.started('held')
      const run = f.managed.run('Use workers.'); await entered.promise
      f.managed.steer('Read this correction immediately.'); released.release()
      await new Promise<void>(resolve => setTimeout(resolve, 50))
      const callsBeforeWorkerFinished = f.adapter.requests.get('lead')?.length ?? 0
      passed = callsBeforeWorkerFinished >= 2; observed = { callsBeforeWorkerFinished, holdWaitMs: 1000 }
      await f.finish('held'); await run
    } finally { released.release(); await f.cleanup() }
  } else if (id === 'quiet-waits-for-setup') {
    const entered = deferred(), prepared = deferred()
    const f = fixture(sdk, { workerFactory: async () => { entered.release(); await prepared.promise; return f.definition } })
    try {
      const setup = f.managed.spawn({ name: 'preparing', task: 'Read evidence.' })
      await entered.promise
      let quiet = false
      const wait = f.managed.whenQuiet().then(() => { quiet = true })
      await checkpoint(); const returnedDuringSetup = quiet
      prepared.release(); await setup; await wait
      passed = !returnedDuringSetup; observed = { returnedDuringSetup }
    } finally { prepared.release(); await f.cleanup() }
  } else if (id === 'close-coalesces-instance') {
    const secondClose = deferred()
    let cancels = 0
    class DelayedCloseTeam extends sdk.agent.AgentTeam {
      override async cancel(name: string, reason?: unknown) {
        if (name === 'same' && ++cancels === 2) await secondClose.promise
        return super.cancel(name, reason)
      }
    }
    const f = fixture(sdk, { team: new DelayedCloseTeam() })
    try {
      await f.managed.spawn({ name: 'same', task: 'Read original evidence.' }); await f.adapter.started('same')
      const first = f.managed.closeWorker('same'), second = f.managed.closeWorker('same')
      await first; f.adapter.rearm('same')
      await f.managed.spawn({ name: 'same', task: 'Read replacement evidence.' }); await f.adapter.started('same')
      secondClose.release(); await second
      const replacementRetained = f.managed.workers().some(w => w.name === 'same')
      passed = replacementRetained; observed = { replacementRetained, originalCancelCalls: cancels }
      f.adapter.finish('same'); await f.managed.team.whenIdle('same')
    } finally { secondClose.release(); await f.cleanup() }
  } else if (id === 'failed-dependency-handoff-no-dispatch') {
    class RejectHandoff extends sdk.agent.AgentTeam {
      private deliveries = 0
      override async sendMessage(request: Parameters<Agent.AgentTeam['sendMessage']>[0]) {
        // This fixture sends the commissioned task first, then required dependency context.
        if (request.from === 'lead' && request.target === 'consumer' && ++this.deliveries === 2) throw new Error('Host refused dependency context')
        return super.sendMessage(request)
      }
    }
    const f = fixture(sdk, { team: new RejectHandoff() })
    try {
      await f.managed.spawn({ name: 'producer', task: 'Read evidence.' }); await f.adapter.started('producer'); await f.finish('producer')
      const consumer = await f.managed.spawn({ name: 'consumer', task: 'Use producer evidence.', dependsOn: ['producer'] })
      await checkpoint()
      const dispatched = f.adapter.requests.has('consumer')
      passed = !dispatched && consumer.status === 'failed' && !!consumer.error?.includes('handoff failed')
      observed = { dispatched, status: consumer.status, error: consumer.error }
    } finally { await f.cleanup() }
  } else if (id === 'quiet-waits-for-report') {
    const entered = deferred(), delivered = deferred()
    class DelayedReportTeam extends sdk.agent.AgentTeam {
      override async sendMessage(request: Parameters<Agent.AgentTeam['sendMessage']>[0]) {
        if (request.from === 'producer' && request.target === 'lead') { entered.release(); await delivered.promise }
        return super.sendMessage(request)
      }
    }
    const f = fixture(sdk, { team: new DelayedReportTeam() })
    try {
      await f.managed.spawn({ name: 'producer', task: 'Read producer evidence.' })
      await f.adapter.started('producer'); f.adapter.finish('producer'); await entered.promise
      let quiet = false
      const wait = f.managed.whenQuiet().then(() => { quiet = true })
      await checkpoint()
      const returnedBeforeDelivery = quiet
      delivered.release(); await wait; await f.managed.awaitWorker('producer')
      passed = !returnedBeforeDelivery && f.managed.team.messages().some(m => m.sender === 'producer')
      observed = { returnedBeforeDelivery, deliveredReports: f.managed.team.messages().filter(m => m.sender === 'producer').length }
    } finally { delivered.release(); await f.cleanup() }
  } else if (id === 'fork-scoped-history-limit') {
    const f = fixture(sdk, { workerSessionOptionsFactory: () => ({ historyLimits: { maxEntries: 1 } }) })
    try {
      f.managed.lead.inject('First completed context.'); f.managed.lead.inject('Second completed context.')
      const result = await f.managed.spawn({ name: 'forked', task: 'Use existing context.', context: 'fork' }).then(() => 'accepted', () => 'rejected')
      passed = result === 'rejected'; observed = { result, configuredMaxEntries: 1 }
    } finally { await f.cleanup() }
  } else if (id === 'host-spawn-setup-timeout') {
    const entered = deferred(), prepared = deferred()
    const f = fixture(sdk, { spawnTimeoutMs: 10, workerTimeoutMs: 5000,
      workerFactory: async () => { entered.release(); await prepared.promise; return f.definition } })
    try {
      let rejected = false
      const setup = f.managed.spawn({ name: 'held_setup', task: 'Read evidence.' }).catch(() => { rejected = true })
      await entered.promise
      await new Promise<void>(resolve => setTimeout(resolve, 40))
      const rejectedBeforeFactoryFinished = rejected
      prepared.release(); await setup
      passed = rejectedBeforeFactoryFinished
      observed = { rejectedBeforeFactoryFinished, setupLimitMs: 10, workerLimitMs: 5000 }
    } finally { prepared.release(); await f.cleanup() }
  } else if (id === 'dependency-completes-during-setup' || id === 'dependency-closes-during-setup') {
    const entered = deferred(), prepared = deferred()
    const f = fixture(sdk, { workerSessionOptionsFactory: async request => {
      if (request.name === 'consumer') { entered.release(); await prepared.promise }
      return {}
    } })
    try {
      await f.managed.spawn({ name: 'producer', task: 'Read evidence.' }); await f.adapter.started('producer')
      const setup = f.managed.spawn({ name: 'consumer', task: 'Use producer facts.', dependsOn: ['producer'] })
      await entered.promise; await f.finish('producer')
      if (id === 'dependency-closes-during-setup') await f.managed.closeWorker('producer')
      prepared.release(); await setup; await f.adapter.started('consumer')
      passed = f.body('consumer').includes('source-producer')
      observed = { producerEvidenceInRequest: passed }; await f.finish('consumer')
    } finally { prepared.release(); await f.cleanup() }
  } else if (id === 'concurrent-write-admission' || id === 'dispose-during-setup') {
    const entered = deferred(), prepared = deferred()
    let factories = 0
    const f = fixture(sdk, { workerFactory: async () => { factories++; entered.release(); await prepared.promise; return f.definition } })
    try {
      const first = f.managed.spawn({ name: 'first', task: 'Write app.', writes: ['app'] }).then(v => ({ ok: true, value: v }), e => ({ ok: false, error: String(e) }))
      await entered.promise
      if (id === 'concurrent-write-admission') {
        const second = f.managed.spawn({ name: 'second', task: 'Write a file.', writes: ['app/page.ts'] }).then(v => ({ ok: true, value: v }), e => ({ ok: false, error: String(e) }))
        prepared.release()
        const results = await Promise.all([first, second])
        passed = results.filter(v => v.ok).length === 1
        observed = { factories, accepted: results.filter(v => v.ok).length, statuses: results }
      } else {
        await f.managed.dispose()
        prepared.release()
        const result = await first
        await checkpoint()
        passed = !result.ok && f.managed.workers().length === 0
        observed = { result, workersAfterDispose: f.managed.workers().length, modelDispatches: [...f.adapter.requests.values()].flat().length }
      }
    } finally { prepared.release(); await f.cleanup() }
  } else if (id === 'failed-spawn-cleanup') {
    const f = fixture(sdk, { team: { maxMessageBytes: 512 } })
    try {
      const result = await f.managed.spawn({ name: 'too_long', task: 'x'.repeat(600) }).then(() => 'accepted', () => 'rejected')
      const retained = f.managed.workers().length
      const registered = f.managed.team.members().some(m => m.name === 'too_long')
      passed = result === 'rejected' && retained === 0 && !registered
      observed = { result, retainedWorkerSlots: retained, stillRegistered: registered }
    } finally { await f.cleanup() }
  } else {
    const f = fixture(sdk)
    try {
      if (id === 'late-dependency-result') {
        await f.managed.spawn({ name: 'producer', task: 'Read producer evidence.' }); await f.adapter.started('producer'); await f.finish('producer')
        await f.managed.spawn({ name: 'consumer', task: 'Use producer facts.', dependsOn: ['producer'] }); await f.adapter.started('consumer')
        passed = f.body('consumer').includes('source-producer')
        observed = { dependencyEvidenceInRequest: passed }; await f.finish('consumer')
      } else if (id === 'closed-multi-dependency-result') {
        await f.managed.spawn({ name: 'fast', task: 'Read fast evidence.' }); await f.adapter.started('fast')
        await f.managed.spawn({ name: 'slow', task: 'Read slow evidence.' }); await f.adapter.started('slow')
        await f.managed.spawn({ name: 'consumer', task: 'Combine both sources.', dependsOn: ['fast', 'slow'] })
        await f.finish('fast'); await f.managed.closeWorker('fast'); f.adapter.finish('slow'); await f.adapter.started('consumer')
        const request = f.body('consumer')
        passed = request.includes('source-fast') && request.includes('source-slow')
        observed = { fastEvidence: request.includes('source-fast'), slowEvidence: request.includes('source-slow') }; await f.finish('consumer')
      } else if (id === 'dependency-name-reuse') {
        await f.managed.spawn({ name: 'first', task: 'Read original evidence.' }); await f.adapter.started('first')
        await f.managed.spawn({ name: 'slow', task: 'Read slow evidence.' }); await f.adapter.started('slow')
        await f.managed.spawn({ name: 'consumer', task: 'Use the commissioned original evidence.', dependsOn: ['first', 'slow'] })
        await f.finish('first'); await f.managed.closeWorker('first')
        f.adapter.rearm('first')
        await f.managed.spawn({ name: 'first', task: 'Replacement evidence must not rebind old dependencies.' })
        await f.adapter.started('first'); await f.finish('slow'); await checkpoint()
        passed = f.body('consumer').includes('source-first')
        observed = { originalEvidence: passed, consumerStarted: f.adapter.requests.has('consumer') }
        f.adapter.finish('consumer')
      } else if (id === 'equivalent-write-scope' || id === 'escaping-write-scope') {
        if (id === 'equivalent-write-scope') { await f.managed.spawn({ name: 'owner', task: 'Write app.', writes: ['app/shared.ts'] }); await f.adapter.started('owner') }
        const scope = id === 'escaping-write-scope' ? '../outside.ts' : 'app/./shared.ts'
        const accepted = await f.managed.spawn({ name: 'other', task: 'Write the scoped file.', writes: [scope] }).then(() => true, () => false)
        passed = !accepted; observed = { scope, accepted }
      } else if (id === 'abort-await-worker' || id === 'abort-when-quiet') {
        await f.managed.spawn({ name: 'held', task: 'Read held evidence.' }); await f.adapter.started('held')
        const controller = new AbortController()
        let rejected = false
        const wait = (id === 'abort-await-worker'
          ? f.managed.awaitWorker('held', { signal: controller.signal, timeoutMs: 2000 })
          : f.managed.whenQuiet(controller.signal)).catch(() => { rejected = true })
        controller.abort(new Error('Caller stopped waiting; worker still owns its run.'))
        await checkpoint()
        const rejectedBeforeWorkerFinished = rejected
        const workerStillRunning = f.managed.workers()[0]?.status === 'running'
        await f.finish('held'); await wait
        passed = rejectedBeforeWorkerFinished && workerStillRunning
        observed = { rejectedBeforeWorkerFinished, workerStillRunning }
      } else if (id === 'dispose-pending-chain') {
        await f.managed.spawn({ name: 'producer', task: 'Read evidence.' }); await f.adapter.started('producer')
        await f.managed.spawn({ name: 'consumer', task: 'Use evidence.', dependsOn: ['producer'] })
        await f.managed.dispose(); await checkpoint()
        const consumerDispatches = f.adapter.requests.get('consumer')?.length ?? 0
        passed = consumerDispatches === 0 && f.managed.workers().length === 0
        observed = { consumerDispatches, remainingWorkers: f.managed.workers().length }
      } else if (id === 'independent-parallel-control') {
        await Promise.all([f.managed.spawn({ name: 'one', task: 'Read one.', writes: ['one.ts'] }), f.managed.spawn({ name: 'two', task: 'Read two.', writes: ['two.ts'] })])
        await Promise.all([f.adapter.started('one'), f.adapter.started('two')])
        passed = f.managed.workers().every(w => w.status === 'running')
        observed = { concurrentRunningWorkers: f.managed.workers().filter(w => w.status === 'running').length }
      } else if (id === 'ordered-write-control') {
        await f.managed.spawn({ name: 'owner', task: 'Write app.', writes: ['app'] }); await f.adapter.started('owner')
        const dependent = await f.managed.spawn({ name: 'next', task: 'Review app.', writes: ['app/page.ts'], dependsOn: ['owner'] })
        const held = dependent.status === 'pending' && !f.adapter.requests.has('next')
        f.adapter.finish('owner'); await f.adapter.started('next')
        passed = held && f.body('next').includes('source-owner'); observed = { held, producerEvidence: f.body('next').includes('source-owner') }; await f.finish('next')
      } else if (id === 'failed-dependency-control') {
        await f.managed.spawn({ name: 'owner', task: 'Read evidence.' }); await f.adapter.started('owner')
        await f.managed.spawn({ name: 'next', task: 'Report missing evidence.', dependsOn: ['owner'] })
        await f.managed.closeWorker('owner'); await f.adapter.started('next')
        passed = f.body('next').includes('closed before reporting') || f.body('next').includes('FAILED') || f.body('next').includes('cancelled')
        observed = { failureNoticeDelivered: passed }; await f.finish('next')
      }
    } finally { await f.cleanup() }
  }
  return { id, passed, observed, elapsedMs: performance.now() - started }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2)
  const option = (key: string) => args[args.indexOf(`--${key}`) + 1]
  const sdkRoot = resolve(option('sdk-root') ?? '')
  const directory = resolve(option('output') ?? '')
  if (!args.includes('--sdk-root') || !args.includes('--output')) throw new Error('--sdk-root and new --output required')
  await mkdir(directory)
  const load = createRequire(resolve(sdkRoot, 'package.json'))
  const coreEntry = load.resolve('@alvin0/ai-agent-sdk-core'), agentEntry = load.resolve('@alvin0/ai-agent-sdk-core/agent')
  const sdk: SDK = { core: await import(pathToFileURL(coreEntry).href), agent: await import(pathToFileURL(agentEntry).href) }
  const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ cases: CASES, sdkRoot, coreEntry, agentEntry,
    coreHash: hash(await readFile(coreEntry)), agentHash: hash(await readFile(agentEntry)), harnessHash: hash(await readFile(import.meta.filename)),
    startedAt: new Date().toISOString(), scope: 'real public SDK/session loop, synthetic controlled adapter; no live model quality or token-cost claim' }, null, 2))
  const results: CaseResult[] = []
  for (const id of CASES) {
    try { results.push(await runCase(sdk, id)) }
    catch (error) { results.push({ id, passed: false, observed: { harnessError: error instanceof Error ? error.message : String(error) }, elapsedMs: 0 }) }
    console.log(JSON.stringify(results.at(-1)))
  }
  await writeFile(resolve(directory, 'results.json'), JSON.stringify({ total: results.length, passed: results.filter(r => r.passed).length, results }, null, 2))
  if (results.some(result => !result.passed)) process.exitCode = 1
}
