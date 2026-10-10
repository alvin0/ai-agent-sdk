import { ModelError } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ModelInvocationContext, PreparedAdapterCall,
  StreamChunk } from '@alvin0/ai-agent-sdk-core/provider'
import type { DecisionInput, DecisionResult } from './types.ts'
import { throwIfAborted } from './async.ts'
import { readDecisionStream } from './llm-stream.ts'
import { decodeLlmOutput } from './llm-decode.ts'
export interface CapturedLlmRequest { readonly input: DecisionInput;
  readonly generation: Omit<GenerateOptions, 'signal'> }
export interface LlmResponseOptions { readonly mode: 'json-schema' | 'tool'; readonly evidence: boolean;
  readonly maxBytes: number }
export async function runLlmDecision(
  prepared: PreparedAdapterCall, captured: CapturedLlmRequest,
  options: LlmResponseOptions, context?: ModelInvocationContext,
): Promise<DecisionResult> {
  const input = captured.input
  const controller = new AbortController()
  const signal = input.signal
  const forward = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forward, { once: true })
  if (signal?.aborted) forward()
  // Prepared calls are public: bound their attempts even without a runtime wrapper.
  const timer = setTimeout(() => controller.abort(new ModelError('LLM decision deadline exceeded',
    'TIMEOUT')), input.timeoutMs ?? 30_000)
  let iterator: AsyncIterator<StreamChunk> | undefined
  let closed = false
  try {
    throwIfAborted(controller.signal)
    const generation: GenerateOptions = {
      ...captured.generation,
      signal: controller.signal,
    }
    iterator = prepared.stream(generation, context)[Symbol.asyncIterator]()
    const output = await readDecisionStream(iterator, controller.signal, options)
    closed = output.closed
    return decodeLlmOutput(output, captured, options)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
    if (!closed) {
      controller.abort()
      // Observe late teardown without allowing a noncooperative iterator to block cancellation.
      try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* preserve the original failure */ }
    }
  }
}
