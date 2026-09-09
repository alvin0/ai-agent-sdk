/**
 * Recording the calls a run makes to a provider.
 *
 * The trace's step rows carry a summary of each request — capped, so a trace
 * stays smaller than the work it describes. This is the other half: the whole
 * payload that went out and the whole stream that came back, for the question
 * a summary cannot answer ("it had the file open, why did it search again?").
 *
 * Recorded with a `StreamMiddleware`, which the registry documents as the
 * extension point for request logging: it wraps every streaming model call, so
 * one middleware covers every provider the run may route to — including the
 * offline one the tests drive.
 *
 * Correlation is by REQUEST IDENTITY, not by timing: the loop's own span
 * carries the model, the message count, and the id of the last message it
 * sent, and message ids are stable. Two agents of a team streaming at once
 * cannot be confused for one another, which a "whichever call was in flight"
 * rule would do.
 */

import type { GenerateOptions, StreamChunk, StreamMiddleware } from '@ai-agent-sdk/core'
import type { WireApiCall } from './wire'

/** What identifies one round's request, on both sides of the recording. */
export type CallFingerprint = string

/**
 * Name a request the way the loop's span names it.
 * @param model - The model the round ran on.
 * @param messageCount - How many messages the request carried.
 * @param lastMessageId - The id of its final message, when it had one.
 * @returns The fingerprint both sides compute.
 */
export function fingerprint(
  model: string,
  messageCount: number,
  lastMessageId: string | undefined,
): CallFingerprint {
  return `${model}|${String(messageCount)}|${lastMessageId ?? ''}`
}

/**
 * Read the fingerprint back off a span's recorded request summary.
 * @param model - The span's model attribute.
 * @param input - The span's `input`, as the loop wrote it.
 * @returns The fingerprint, or undefined when the span carries no summary.
 */
export function fingerprintOf(model: string, input: unknown): CallFingerprint | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const summary = input as { messageCount?: unknown; lastMessageId?: unknown }
  if (typeof summary.messageCount !== 'number') return undefined
  return fingerprint(
    model,
    summary.messageCount,
    typeof summary.lastMessageId === 'string' ? summary.lastMessageId : undefined,
  )
}

/**
 * How much of one payload is kept.
 *
 * A conversation with a large file pasted into it can be megabytes, and a
 * trace is read, not archived. The TAIL is kept when the cut has to be made:
 * the recent turns are what explain the round.
 */
const MAX_MESSAGES = 60

/** Longest text kept for one block or one streamed answer, in characters. */
const MAX_TEXT = 20_000

function clip(text: string, limit = MAX_TEXT): { text: string; cut: boolean } {
  return text.length > limit
    ? { text: `${text.slice(0, limit)}…`, cut: true }
    : { text, cut: false }
}

/** Everything but the messages: the knobs the request set. */
function paramsOf(request: GenerateOptions): Record<string, unknown> {
  const {
    messages: _messages, system: _system, signal: _signal, tools, ...rest
  } = request as GenerateOptions & Record<string, unknown>
  void _messages
  void _system
  void _signal
  return {
    ...rest,
    // The schemas themselves are long and rarely the question; the names are
    // what a reader checks ("was edit_file even offered?").
    ...tools === undefined ? {} : { tools: tools.map(tool => tool.name) },
  }
}

/** One message, with its long text cut and the cut declared. */
function messageOf(message: unknown, cuts: { any: boolean }): unknown {
  if (typeof message !== 'object' || message === null) return message
  const source = message as { role?: unknown; content?: unknown }
  if (!Array.isArray(source.content)) return message
  const content = source.content.map((block: unknown) => {
    if (typeof block !== 'object' || block === null) return block
    const entry = block as Record<string, unknown>
    if (typeof entry.text !== 'string') return entry
    const clipped = clip(entry.text)
    if (clipped.cut) cuts.any = true
    return { ...entry, text: clipped.text }
  })
  return { ...source, content }
}

/** What one run's provider calls are handed to when they finish. */
export type CallSink = (call: WireApiCall, id: CallFingerprint) => void

/**
 * Record every model call of one run.
 * @param sink - Receives each finished call with its fingerprint.
 * @returns The middleware to install on the run's registry.
 */
export function recordProviderCalls(sink: CallSink): StreamMiddleware {
  return (request, next) => {
    const model = String(request.model)
    const messages = request.messages ?? []
    const id = fingerprint(model, messages.length, messages.at(-1)?.id)
    const at = Date.now()
    const cuts = { any: messages.length > MAX_MESSAGES }
    const kept = messages.slice(-MAX_MESSAGES).map(message => messageOf(message, cuts))
    const system = request.system === undefined ? undefined : clip(request.system)
    if (system?.cut === true) cuts.any = true

    // An async generator, so the recording ends when the STREAM ends rather
    // than when the call was made: the response is the half that arrives late.
    return (async function* record(): AsyncIterable<StreamChunk> {
      let chunks = 0
      let text = ''
      let reasoning = ''
      const toolCalls: { name: string; arguments: string }[] = []
      let usage: WireApiCall['response']['usage']
      let finishReason: string | undefined
      let error: string | undefined
      try {
        for await (const chunk of next()) {
          chunks += 1
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
          else if (chunk.type === 'usage') usage = { ...chunk.usage }
          else if (chunk.type === 'finish') finishReason = chunk.reason.kind
          else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
            toolCalls.push({ name: chunk.block.name, arguments: chunk.block.arguments })
          }
          yield chunk
        }
      } catch (failure) {
        // Recorded and re-thrown: a call that failed is the one most worth
        // reading, and swallowing it here would break the run.
        error = failure instanceof Error ? failure.message : String(failure)
        throw failure
      } finally {
        const answer = clip(text)
        const thought = clip(reasoning)
        sink({
          at,
          durationMs: Date.now() - at,
          provider: String(request.provider),
          model,
          params: paramsOf(request),
          messages: kept,
          ...system === undefined ? {} : { system: system.text },
          ...cuts.any || answer.cut || thought.cut ? { truncated: true as const } : {},
          response: {
            chunks,
            ...answer.text === '' ? {} : { text: answer.text },
            ...thought.text === '' ? {} : { reasoning: thought.text },
            ...toolCalls.length === 0 ? {} : { toolCalls },
            ...usage === undefined ? {} : { usage },
            ...finishReason === undefined ? {} : { finishReason },
            ...error === undefined ? {} : { error },
          },
        }, id)
      }
    })()
  }
}
