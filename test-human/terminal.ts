/** Agent-event rendering and terminal human-in-loop questions. */

import { stdout } from 'node:process'
import type { Interface } from 'node:readline/promises'
import type { AgentRunEvent } from '@ai-agent-sdk/agent'
import type { ToolExecutionResult } from '@ai-agent-sdk/agent'
import type {
  InteractiveUserInputBroker,
  UserInputQuestion,
  UserInputResponse,
} from '@ai-agent-sdk/agent'
import type { HumanCliConfig } from './config.ts'
import { label, paint } from './console.ts'
import { saveGeneratedImages } from './media.ts'

export async function renderHumanRun(
  stream: AsyncIterable<AgentRunEvent>,
  config: HumanCliConfig,
  broker: InteractiveUserInputBroker,
  terminal: Interface,
): Promise<void> {
  let streamingText = false
  let streamBlock = ''
  const partials = new Map<string, number>()

  for await (const event of stream) {
    if (event.type === 'text-delta') {
      const block = `${event.index}:${event.phase}`
      if (streamBlock !== block) {
        if (streamingText) stdout.write('\n')
        stdout.write(`${label(`assistant/${event.phase}`)} `)
        streamBlock = block
      }
      stdout.write(event.text)
      streamingText = true
    } else if (event.type === 'reasoning-delta' && config.showReasoning) {
      streamingText = endStreamLine(streamingText)
      stdout.write(`${label('reasoning-summary')} ${event.text}`)
    } else if (event.type === 'tool-call') {
      streamingText = endStreamLine(streamingText)
      console.log(
        label('tool-call'), event.call.callId, event.call.toolName,
        summarizeToolArguments(event.call.rawArguments),
      )
    } else if (event.type === 'tool-result') {
      console.log(label('tool-result'), event.call.callId, summarizeToolResult(event.result))
    } else if (event.type === 'image-delta') {
      const count = (partials.get(event.itemId) ?? 0) + 1
      partials.set(event.itemId, count)
      console.log(label('image-progress'), event.itemId, `partial=${event.partialIndex ?? count}`, event.mediaType)
    } else if (event.type === 'assistant-native-tool') {
      streamingText = endStreamLine(streamingText)
      console.log(label('native-tool'), event.call.id, event.call.name, event.call.status ?? '')
      await saveGeneratedImages(event.call.id, event.call.content)
    } else if (event.type === 'assistant-message') {
      const citations = event.message.content.flatMap(block =>
        block.type === 'text' ? block.annotations ?? [] : [])
      if (citations.length > 0) streamingText = endStreamLine(streamingText)
      for (const citation of citations) {
        if (citation.type === 'url-citation') {
          console.log(label('citation'), citation.title ?? '', citation.url)
        }
      }
    } else if (event.type === 'compaction-start') {
      streamingText = endStreamLine(streamingText)
      console.log(label('compact'), event.trigger, `~${event.estimatedInputTokens} input tokens`)
    } else if (event.type === 'compaction-end') {
      console.log(label('compact'), event.status, {
        id: event.compactionId,
        shadowed: event.shadowedSeqs.length,
        before: event.estimatedTokensBefore,
        after: event.estimatedTokensAfter,
        saved: event.estimatedTokensBefore - event.estimatedTokensAfter,
        ...(event.thresholdTokens === undefined ? {} : { threshold: event.thresholdTokens }),
        ...(event.estimatedNonCompactableTokens === undefined
          ? {} : { floor: event.estimatedNonCompactableTokens }),
        ...(event.backoffReason === undefined ? {} : {
          backoff: event.backoffReason,
          cooldownSteps: event.cooldownSteps,
        }),
        ...(event.error === undefined ? {} : { error: event.error }),
      })
    } else if (event.type === 'user-input-request') {
      streamingText = endStreamLine(streamingText)
      const response = await askHuman(event.request.questions, terminal)
      if (response === 'abort') broker.abortAll()
      else if (!broker.resolve(event.request.requestId, response)) {
        console.error(label('warning'), `request ${event.request.requestId} was no longer pending`)
      }
    } else if (event.type === 'agent-end') {
      streamingText = endStreamLine(streamingText)
      console.log(label('outcome'), JSON.stringify(event.outcome, null, 2))
    }
  }
}

function endStreamLine(active: boolean): false {
  if (active) stdout.write('\n')
  return false
}

async function askHuman(
  questions: readonly UserInputQuestion[],
  terminal: Interface,
): Promise<UserInputResponse | 'abort'> {
  const answers: Record<string, { answers: string[] }> = {}
  console.log(label('human-input'), 'the model is waiting for your decision')
  for (const question of questions) {
    console.log(paint(33, `${question.header}: ${question.question}`))
    question.options.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option.label} — ${option.description}`)
    })
    const answer = (await terminal.question(
      '  choose a number or type a free-form answer (/abort): ',
    )).trim()
    if (answer === '/abort') return 'abort'
    const option = /^\d+$/.test(answer) ? question.options[Number(answer) - 1] : undefined
    answers[question.id] = { answers: [option?.label ?? answer] }
  }
  return { answers }
}

export function summarizeToolArguments(rawArguments: string): string {
  try { return JSON.stringify(summarizeValue(JSON.parse(rawArguments) as unknown, 'arguments')) }
  catch { return summarizeString(rawArguments, 400) }
}

export function summarizeToolResult(result: ToolExecutionResult): string {
  if (result.isError) return JSON.stringify({
    isError: true,
    error: { ...result.error, message: summarizeString(result.error.message, 1_000) },
  })
  return JSON.stringify({
    isError: false,
    value: summarizeValue(result.value, 'value'),
    ...(result.meta === undefined ? {} : { meta: summarizeValue(result.meta, 'meta') }),
    ...(result.concludesTurn === true ? { concludesTurn: true } : {}),
  })
}

function summarizeValue(value: unknown, key: string, depth = 0): unknown {
  if (typeof value === 'string') {
    if (key === 'content' || key === 'oldText' || key === 'newText') return `<${value.length} chars>`
    if (key === 'text') return `<${value.length} chars of file text>`
    if (key === 'stdout' || key === 'stderr') return summarizeString(value, 1_000)
    return summarizeString(value, 240)
  }
  if (value === null || typeof value !== 'object') return value
  if (depth >= 3) return Array.isArray(value) ? `<${value.length} items>` : '<object>'
  if (Array.isArray(value)) {
    const limit = key === 'matches' ? 5 : 10
    const items = value.slice(0, limit).map(item => summarizeValue(item, key, depth + 1))
    return value.length <= limit ? items : [...items, `<${value.length - limit} more items>`]
  }
  const output: Record<string, unknown> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [childKey, child] of entries.slice(0, 30)) {
    output[childKey] = summarizeValue(child, childKey, depth + 1)
  }
  if (entries.length > 30) output._omittedKeys = entries.length - 30
  return output
}

function summarizeString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 24))}… <${value.length} chars>`
}
