import type { ContentBlock, Message, ToolResultBlock, TextBlock } from '../../message/index.ts'
import type { BeforeStepContext } from '../loop/events.ts'
import type { SpillRecord } from '../tool/output-budget.ts'
import { diagnosticLineNumbers, reduceEvidence } from '../tool/evidence-reducer.ts'
import { byteLength, mapSequential, utf8Prefix, type OptimizerConfig } from './context-optimizer-support.ts'
import type { MutableOptimizationMetrics } from './context-optimizer-types.ts'

interface Observation {
  readonly text: string
  readonly record: SpillRecord
  exposures: number
  reduced?: string
  reductionAttempted: boolean
  readonly log?: { readonly status: 'pass' | 'fail' | 'unknown'; readonly requiredLines?: readonly number[] }
  packed?: string
}
interface SaveInput {
  readonly key: string
  readonly text: string
  readonly bytes: number
  readonly toolName: string
  readonly callId: string
  readonly logInfo: Observation['log']
  readonly signal: AbortSignal
}

export class ObservationProjector {
  readonly observations = new Map<string, Observation>()
  constructor(
    private readonly config: OptimizerConfig,
    private readonly metrics: MutableOptimizationMetrics,
    private readonly isDisposed: () => boolean,
    private readonly retrievalName: string,
  ) {}

  async project(context: BeforeStepContext): Promise<Message[]> {
    const toolNames = new Map(context.snapshot.entries.flatMap(entry => entry.event.kind === 'tool-call'
      ? [[String(entry.event.callId), entry.event.name] as const] : []))
    return mapSequential(context.messages, message => this.projectMessage(message, toolNames, context))
  }

  private async projectMessage(
    message: Message, toolNames: ReadonlyMap<string, string>, context: BeforeStepContext,
  ): Promise<Message> {
    const content = await mapSequential(message.content, block => this.projectBlock(block, message, toolNames, context))
    return { ...message, content }
  }

  private async projectBlock(
    block: ContentBlock, message: Message, toolNames: ReadonlyMap<string, string>, context: BeforeStepContext,
  ): Promise<ContentBlock> {
    if (block.type !== 'tool-result') return block
    const toolName = toolNames.get(String(block.toolCallId)) ?? ''
    if (toolName === this.retrievalName) return block
    const content = await mapSequential(block.content, (child, index) =>
      this.projectChild(child, { message, block, toolName, index, context }))
    return { ...block, content }
  }

  private async projectChild(child: ContentBlock, input: {
    readonly message: Message; readonly block: ToolResultBlock; readonly toolName: string
    readonly index: number; readonly context: BeforeStepContext
  }): Promise<ContentBlock> {
    const { context } = input
    if (this.isDisposed()) return child
    context.signal.throwIfAborted()
    if (child.type !== 'text') return child
    const captured = await this.prepareObservation(child.text, input)
    if (captured === undefined) return child
    return this.projectCapturedObservation(child, captured, context.signal)
  }

  private candidate(text: string, key: string, toolName: string) {
    const { threshold, reductionThreshold, reducer } = this.config
    const observation = this.observations.get(key)
    if (observation !== undefined && observation.text !== text) return undefined
    const bytes = observation?.record.bytes ?? byteLength(text)
    const logInfo = this.identifyLog(observation, toolName, text, bytes)
    const large = bytes > threshold
    const reducible = reducer !== undefined && logInfo !== undefined && bytes > reductionThreshold
    if (!large && !reducible) return undefined
    return { observation, bytes, logInfo, large, reducible }
  }

  private async prepareObservation(text: string, input: {
    readonly message: Message; readonly block: ToolResultBlock; readonly toolName: string
    readonly index: number; readonly context: BeforeStepContext
  }) {
    const { message, block, toolName, index, context } = input
    const key = `${message.id}:${block.toolCallId}:${index}`
    const candidate = this.candidate(text, key, toolName)
    if (candidate === undefined) return undefined
    let observation = candidate.observation
    if (observation === undefined) {
      observation = await this.saveObservation({ key, text, bytes: candidate.bytes, toolName,
        callId: String(block.toolCallId), logInfo: candidate.logInfo, signal: context.signal })
      if (observation === undefined) return undefined
    }
    if (candidate.large && observation.exposures < this.config.fullRequests) return undefined
    return { ...candidate, observation }
  }

  private async projectCapturedObservation(child: TextBlock, captured: {
    readonly observation: Observation; readonly bytes: number; readonly logInfo: Observation['log']
    readonly reducible: boolean
  }, signal: AbortSignal): Promise<TextBlock> {
    const { observation, bytes, logInfo, reducible } = captured
    // Retention is owned by the store. Do not emit a pointer known to be expired.
    if (!await this.retained(observation)) return child
    if (this.isDisposed()) return child
    signal.throwIfAborted()
    if (observation.packed !== undefined) {
      this.metrics.packedObservations++
      return { ...child, text: observation.packed }
    }
    if (reducible && !observation.reductionAttempted) {
      if (!await this.reduceObservation(observation, logInfo, signal)) return child
    }
    // Invalid reductions always preserve the original, including on later requests.
    if (reducible && observation.reduced === undefined) return child
    return this.packObservation(observation, child, bytes)
  }

  private async retained(observation: Observation): Promise<boolean> {
    try { return await this.config.store.read(observation.record.locator, { offset: 0, limit: 1 }) !== undefined }
    catch { return false }
  }

  private identifyLog(observation: Observation | undefined, toolName: string, text: string, bytes: number) {
    let identified = observation?.log
    if (observation === undefined && bytes > this.config.reductionThreshold) {
      identified = this.config.log?.(toolName, text)
    }
    if (identified === undefined) return undefined
    return Object.freeze({ status: identified.status,
      ...identified.requiredLines === undefined ? {}
        : { requiredLines: Object.freeze([...identified.requiredLines]) } })
  }

  private async saveObservation(input: SaveInput): Promise<Observation | undefined> {
    const { key, text, bytes, toolName, callId, logInfo, signal } = input
    if (this.observations.size >= this.config.maxObservations) return undefined
    try {
      const record = await this.config.store.save(text, { toolName, callId })
      if (this.isDisposed()) return undefined
      signal.throwIfAborted()
      const captured = Object.freeze({ locator: record.locator, retrieval: record.retrieval, bytes: record.bytes })
      if (!validRecord(captured, bytes)) return undefined
      const observation: Observation = { text, record: captured, exposures: 0, reductionAttempted: false,
        ...logInfo === undefined ? {} : { log: { ...logInfo,
          ...logInfo.requiredLines === undefined ? {}
            : { requiredLines: Object.freeze([...logInfo.requiredLines]) } } } }
      this.observations.set(key, observation)
      return observation
    } catch { return undefined }
  }

  private async reduceObservation(
    observation: Observation, logInfo: Observation['log'], signal: AbortSignal,
  ): Promise<boolean> {
    if (logInfo === undefined || this.config.reducer === undefined) return true
    observation.reductionAttempted = true
    const result = await reduceEvidence({ text: observation.text, status: logInfo.status,
      signal }, this.config.reducer, logInfo.requiredLines)
    if (this.isDisposed()) return false
    signal.throwIfAborted()
    if (result.accepted) { observation.reduced = result.text; this.metrics.verifiedReductions++; return true }
    this.metrics.rejectedReductions++
    return false
  }

  private packObservation(observation: Observation, child: TextBlock, bytes: number): TextBlock {
    const { summaryBytes } = this.config
    const metrics = this.metrics
    const header = `[Observation stored. ID: ${observation.record.locator}; bytes: ${bytes}]\n`
      + `${observation.record.retrieval}\n`
    let body = observation.reduced
    if (body === undefined) {
      const lines = child.text.split('\n')
      const evidence = diagnosticLineNumbers(child.text).map(line => `${line}: ${lines[line - 1]}`).join('\n')
      const room = summaryBytes - byteLength(header) - byteLength(evidence) - 40
      if (room <= 0) return child
      body = `${utf8Prefix(child.text, room)}\n[Preview; omitted text is retrievable]\n${evidence}`
    }
    const text = header + body
    if (byteLength(text) >= bytes) return child
    observation.packed = text
    metrics.packedObservations++
    return { ...child, text }
  }
}

function validRecord(record: SpillRecord, bytes: number): boolean {
  return typeof record.locator === 'string' && Boolean(record.locator) && typeof record.retrieval === 'string'
    && Boolean(record.retrieval) && record.bytes === bytes
}
