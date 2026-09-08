/**
 * An offline provider, for a demo with no credentials and for tests.
 *
 * Everything else in this sample needs a real key or a ChatGPT sign-in, which
 * makes two ordinary things impossible: showing the UI to someone who has
 * neither, and exercising the whole request path — approvals, transcripts,
 * takeovers, usage — without talking to a model. This adapter answers from a
 * script instead.
 *
 * It is OFF unless `CHAT_AGENTS_MOCK_MODEL` is set, so a real deployment cannot
 * accidentally route a conversation to a machine that makes things up.
 */

import { ModelAdapter } from '@ai-agent-sdk/core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@ai-agent-sdk/core'

/** The provider id an offline conversation runs on. */
export const MOCK_PROVIDER = 'mock'

/** Models the picker offers for it. */
export const MOCK_MODELS: readonly string[] = ['mock-scripted']

/**
 * One scripted reply. A round is the chunks the adapter yields for one request.
 */
export type MockRound = readonly StreamChunk[]

/** How the adapter decides what to answer next. */
export type MockScript = (request: GenerateOptions, index: number) => MockRound | undefined

let script: MockScript | undefined

/**
 * Install what the offline provider answers.
 *
 * A function rather than a list, so a caller can branch on what the model was
 * actually sent — which is the difference between replaying a fixture and
 * testing a conversation.
 * @param next - The script, or undefined to go back to the canned reply.
 */
export function setMockScript(next: MockScript | undefined): void {
  script = next
}

/** Whether the offline provider is available at all. */
export function mockEnabled(): boolean {
  return (process.env.CHAT_AGENTS_MOCK_MODEL ?? '') !== ''
}

const CANNED = 'This conversation is running on the offline provider: no model was called.'

/** Requests the adapter has served, oldest first. */
const requests: GenerateOptions[] = []

/**
 * What the offline provider has been asked, for a test that wants to look.
 * @returns Every request, in order.
 */
export function mockRequests(): readonly GenerateOptions[] {
  return requests
}

/** Forget the script and the recorded requests. */
export function resetMock(): void {
  script = undefined
  requests.length = 0
  contextWindow = undefined
}

let contextWindow: number | undefined

/**
 * Declare a context window for the offline model.
 *
 * Compaction only engages against a model that says how much room it has, so a
 * test for it has to be able to say.
 * @param tokens - The window to advertise, or undefined to advertise none.
 */
export function setMockContextWindow(tokens: number | undefined): void {
  contextWindow = tokens
}

class MockAdapter extends ModelAdapter {
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    // No reasoning efforts: a provider that declares none must be sent none,
    // and this is the cheapest place to keep that path exercised.
    return Promise.resolve({
      provider, id: model, name: model,
      ...contextWindow === undefined ? {} : { context: { contextWindow, maxInputTokens: contextWindow } },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = requests.length
    requests.push(options)
    const round = script?.(options, index)
    if (round !== undefined) {
      for (const chunk of round) {
        // A script can ask to hang here, which is how a test reproduces a model
        // that is still thinking when the user cancels.
        if ((chunk as { type: string }).type === 'hang') {
          const held = chunk as unknown as { signal?: AbortSignal; ms?: number }
          await new Promise<void>((resolve) => {
            const signal = held.signal ?? options.signal
            signal?.addEventListener('abort', () => { resolve() }, { once: true })
            // A bounded hang models a model that is merely slow, rather than one
            // that only ends when something cancels it.
            if (held.ms !== undefined) setTimeout(resolve, held.ms)
          })
          options.signal?.throwIfAborted()
          continue
        }
        yield chunk
      }
      return
    }
    yield { type: 'text-delta', index: 0, text: CANNED }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: CANNED, phase: 'final-answer' } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * The offline adapter.
 * @returns An adapter that answers from the installed script.
 */
export function mockAdapter(): ModelAdapter {
  return new MockAdapter()
}
