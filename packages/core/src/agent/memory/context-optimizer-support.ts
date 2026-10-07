import type { Message } from '../../message/index.ts'
import type { ContextOptimizerOptions } from './context-optimizer-types.ts'

export function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}
export function byteLength(text: string): number { return new TextEncoder().encode(text).byteLength }
export async function mapSequential<T, U>(
  items: readonly T[], map: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const result: U[] = []
  for (let index = 0; index < items.length; index++) result.push(await map(items[index]!, index))
  return result
}
export function utf8Prefix(text: string, bytes: number): string {
  let result = '', used = 0
  for (const point of text) { used += byteLength(point); if (used > bytes) break; result += point }
  return result
}
export function balanced(messages: readonly Message[]): boolean {
  const calls = new Set<string>(), results = new Set<string>()
  for (const message of messages) for (const block of message.content) {
    if (block.type === 'tool-call') calls.add(String(block.id))
    if (block.type === 'tool-result') results.add(String(block.toolCallId))
  }
  return calls.size === results.size && [...calls].every(id => results.has(id))
}

export function optimizerConfig(options: ContextOptimizerOptions) {
  const threshold = positive(options.observationThresholdBytes ?? 10 * 1024, 'observationThresholdBytes')
  const summaryBytes = positive(options.summaryBytes ?? 1024, 'summaryBytes')
  if (summaryBytes < 256) throw new RangeError('summaryBytes must be at least 256')
  const fullRequests = positive(options.fullRequests ?? 2, 'fullRequests')
  const maxObservations = positive(options.maxObservations ?? 64, 'maxObservations')
  const maxMilestones = positive(options.maxMilestones ?? 128, 'maxMilestones')
  const reductionThreshold = positive(options.reductionThresholdBytes ?? 4 * 1024, 'reductionThresholdBytes')
  return { threshold, summaryBytes, fullRequests, maxObservations, maxMilestones, reductionThreshold,
    store: options.store, archive: options.archive, reducer: options.reducer, log: options.log }
}

export type OptimizerConfig = ReturnType<typeof optimizerConfig>
