import {
  ModelAdapter,
  ModelRegistry,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type ResolvedModelInfo,
  type StreamChunk,
} from '@ai-agent-sdk/core'
import { buildTraceTree, defineAgent, defineTool, type AgentRunEvent, type TraceEvent } from '@ai-agent-sdk/core/agent'
import type { SdkStressContext, SdkStressScenarioResult } from '../types.ts'
import { runBoundedWorkers, StressChecks } from './shared.ts'

export async function agentToolPressure(context: SdkStressContext): Promise<SdkStressScenarioResult> {
  const checks = new StressChecks()
  const toolsPerRun = context.config.profile === 'complex' ? 6 : context.config.profile === 'stress' ? 12 : 16
  let completed = 0
  let events = 0
  let toolCalls = 0
  let toolResults = 0
  let missingUsageCalls = 0
  let failedToolResults = 0
  const failures: string[] = []
  await runBoundedWorkers(context.iterations, 16, context.signal, async index => {
    const adapter = new PressureAdapter(toolsPerRun, index)
    const registry = new ModelRegistry()
    registry.registerAdapter(['stress'], adapter)
    const tool = defineTool({
      name: 'pressure_work',
      description: 'Execute one deterministic pressure work item.',
      parameters: {
        type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false,
      },
      parse: input => input as { value: number },
      isConcurrencySafe: () => true,
      async execute({ value }) {
        await Promise.resolve()
        if ((value + index) % 23 === 0) throw new Error('deterministic work-item failure')
        return { value, doubled: value * 2 }
      },
    })
    const session = defineAgent({
      id: `pressure-${index}`, provider: 'stress', model: 'deterministic', effort: 'medium',
      instructions: 'Execute all pressure work, inspect failures, then return the final answer.',
      tools: [tool], compaction: false, maxTurns: 4,
    }).createSession({ registry })
    session.memory.remember({ kind: 'constraint', content: `pressure-seed-${index}` })
    const handle = session.stream(`run pressure case ${index}`)
    const observed: AgentRunEvent[] = []
    for await (const event of handle) observed.push(event)
    const response = await handle.result
    const report = await handle.report
    const traceEvents = observed.filter((event): event is TraceEvent =>
      event.type === 'span-start' || event.type === 'span-end')
    const starts = traceEvents.filter(event => event.type === 'span-start')
    const ends = traceEvents.filter(event => event.type === 'span-end')
    const calls = observed.filter(event => event.type === 'tool-call').length
    const results = observed.filter(event => event.type === 'tool-result')
    const problems: string[] = []
    if (response.outcome.reason.kind !== 'completed') problems.push(`outcome=${response.outcome.reason.kind}`)
    if (calls !== toolsPerRun || results.length !== toolsPerRun) {
      problems.push(`tool calls/results=${calls}/${results.length}, expected=${toolsPerRun}`)
    }
    if (starts.length !== ends.length || buildTraceTree(traceEvents).length !== 1) {
      problems.push(`trace starts/ends=${starts.length}/${ends.length}`)
    }
    if (report.operationCounts.tool?.unknown !== 0) problems.push('unknown tool terminal state')
    if (report.usage.coverage.missing < 1 || report.usage.authoritative) {
      problems.push(`usage coverage missing=${report.usage.coverage.missing} authoritative=${report.usage.authoritative}`)
    }
    if (!session.memory.items().some(item =>
      item.kind === 'constraint' && item.content === `pressure-seed-${index}`)) {
      problems.push('durable memory item lost')
    }
    if (problems.length > 0) failures.push(`case ${index}: ${problems.join(', ')}`)
    completed++
    events += observed.length
    toolCalls += calls
    toolResults += results.length
    failedToolResults += results.filter(event => event.type === 'tool-result' && event.result.isError).length
    missingUsageCalls += report.usage.coverage.missing
    if (index < 4 || index === context.iterations - 1) {
      context.artifact.record('agent-sample', {
        index, runId: handle.runId, events: observed.length, calls, results: results.length,
        failedToolResults: results.filter(event => event.type === 'tool-result' && event.result.isError).length,
        operationCounts: report.operationCounts, usageCoverage: report.usage.coverage,
      })
    }
  })
  checks.equal('every isolated agent run reaches a terminal result', completed, context.iterations)
  checks.equal('every model tool call has one result', toolResults, toolCalls)
  checks.check('all traces close and all operation state machines terminate', failures.length === 0, failures.slice(0, 8).join('; '))
  checks.check('missing usage stays explicitly non-authoritative under load', missingUsageCalls >= context.iterations)
  checks.check('deterministic tool failures are contained and observable', failedToolResults > 0,
    `failed tool results=${failedToolResults}`)
  return Object.freeze({
    invariants: checks.items(),
    metrics: Object.freeze({
      sessions: context.iterations, toolsPerRun, events, toolCalls, toolResults,
      failedToolResults, missingUsageCalls, peakRssBytes: process.memoryUsage().rss,
    }),
  })
}

class PressureAdapter extends ModelAdapter {
  private request = 0
  constructor(private readonly tools: number, private readonly caseIndex: number) { super() }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      context: { contextWindow: 32_000 },
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const request = this.request++
    if (request === 0) {
      for (let index = 0; index < this.tools; index++) {
        yield {
          type: 'block-end', index,
          block: {
            type: 'tool-call', id: ToolCallId(`pressure-${this.caseIndex}-${index}`),
            name: 'pressure_work', arguments: JSON.stringify({ value: index }),
          },
        }
      }
      // Deliberately no usage: this exercises the SDK's missing-accounting contract.
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = `pressure case ${this.caseIndex} complete`
    yield { type: 'text-delta', index: 0, text, phase: 'final-answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text, phase: 'final-answer' } }
    yield { type: 'usage', usage: { inputTokens: 100 + this.tools, outputTokens: 8, totalTokens: 108 + this.tools } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
