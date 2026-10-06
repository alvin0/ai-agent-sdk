import type { ModelInvocationContext } from '@alvin0/ai-agent-sdk-core/provider'
import { ModelError, MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'
import { abortable, throwIfAborted } from './async.ts'
import type { DecisionDescription, DecisionInput, DecisionModelHandle, DecisionQuestions, DecisionResult } from './types.ts'
import { bindDecisionInput, decisionError, snapshotDecisionInput } from './validation.ts'

export interface DecisionCallOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}
export interface DecisionBatchOptions extends DecisionCallOptions {
  /** Concurrent logical calls, including their retries. Default: 4. */
  readonly concurrency?: number
  readonly context?: ModelInvocationContext
}
export type DecisionBatchItem<Q extends DecisionQuestions> =
  | { readonly status: 'fulfilled'; readonly value: DecisionResult<Q> }
  | { readonly status: 'rejected'; readonly reason: unknown }

/** Independent states: ordered partial results; batch cancellation/deadline rejects the whole operation. */
export async function evaluateDecisionBatch<Q extends DecisionQuestions>(
  model: DecisionModelHandle, inputs: readonly DecisionInput<Q>[], options: DecisionBatchOptions = {},
): Promise<readonly DecisionBatchItem<Q>[]> {
  const concurrency = options.concurrency ?? 4
  const timeout = options.timeoutMs ?? 30_000
  const signal = options.signal
  const context = options.context
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 256) decisionError('Invalid decision batch concurrency')
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) decisionError('Invalid decision batch timeout')
  if (!Array.isArray(inputs) || inputs.length > 1_024) decisionError('Decision batch accepts at most 1024 inputs')
  const controller = new AbortController()
  const forward = () => controller.abort(new ModelError('Decision batch aborted', MODEL_ERROR_CODES.ABORTED))
  signal?.addEventListener('abort', forward, { once: true })
  if (signal?.aborted) forward()
  const timer = setTimeout(() => controller.abort(new ModelError('Decision batch deadline exceeded', MODEL_ERROR_CODES.TIMEOUT)), timeout)
  try {
    throwIfAborted(controller.signal)
    // Include queued inputs in the snapshot: caller edits cannot change later dispatches.
    const captured = Array.from(inputs, input => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) decisionError('Invalid decision batch input')
      if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647)) decisionError('Invalid decision item timeout')
      return snapshotDecisionInput<Q>(input)
    })
    const results: DecisionBatchItem<Q>[] = new Array(captured.length)
    let next = 0
    const worker = async () => {
      while (next < captured.length) {
        throwIfAborted(controller.signal)
        const index = next++
        const input = captured[index]!
        const item = new AbortController()
        const signals = [controller.signal, ...(input.signal === undefined ? [] : [input.signal])]
        const abortItem = () => item.abort(signals.find(signal => signal.aborted)?.reason)
        signals.forEach(signal => { signal.addEventListener('abort', abortItem, { once: true }); if (signal.aborted) abortItem() })
        const itemTimer = input.timeoutMs === undefined ? undefined : setTimeout(() => item.abort(new ModelError('Decision item deadline exceeded', MODEL_ERROR_CODES.TIMEOUT)), input.timeoutMs)
        try {
          throwIfAborted(item.signal)
          const value = await abortable(Promise.resolve().then(() => {
            throwIfAborted(item.signal)
            return model.evaluate<Q>(bindDecisionInput(input, { signal: item.signal }), context)
          }), item.signal)
          results[index] = Object.freeze({ status: 'fulfilled', value })
        } catch (reason) {
          throwIfAborted(controller.signal)
          results[index] = Object.freeze({ status: 'rejected', reason })
        } finally {
          clearTimeout(itemTimer)
          signals.forEach(signal => signal.removeEventListener('abort', abortItem))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, captured.length) }, worker))
    throwIfAborted(controller.signal)
    return Object.freeze(results)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

export interface DecisionTaskOptions<Q extends DecisionQuestions> {
  readonly questions: Q
  /** Per-state logical deadline. The batch deadline is configured separately. */
  readonly timeoutMs?: number
  readonly context?: ModelInvocationContext
}
export interface DecisionTask<Q extends DecisionQuestions> {
  readonly questions: Q
  evaluate(state: DecisionDescription, options?: DecisionCallOptions, context?: ModelInvocationContext): Promise<DecisionResult<Q>>
  evaluateBatch(states: readonly DecisionDescription[], options?: DecisionBatchOptions): Promise<readonly DecisionBatchItem<Q>[]>
}
/** Bind a reusable rubric to any model handle; keep model selection and credentials in setup code. */
export function createDecisionTask<const Q extends DecisionQuestions>(model: DecisionModelHandle, options: DecisionTaskOptions<Q>): DecisionTask<Q> {
  const questions = snapshotDecisionInput({ state: '', questions: options.questions }).questions
  const timeoutMs = options.timeoutMs
  const context = options.context
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)) decisionError('Invalid decision task timeout')
  const input = (state: DecisionDescription, call: DecisionCallOptions = {}): DecisionInput<Q> => ({
    state, questions, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...call,
  })
  return Object.freeze({
    questions,
    evaluate(state: DecisionDescription, call?: DecisionCallOptions, invocation = context) { return model.evaluate(input(state, call), invocation) },
    evaluateBatch(states: readonly DecisionDescription[], batch: DecisionBatchOptions = {}) {
      if (!Array.isArray(states) || states.length > 1_024) return Promise.reject(new ModelError('Decision batch accepts at most 1024 states', MODEL_ERROR_CODES.INVALID_REQUEST))
      return evaluateDecisionBatch(model, states.map(state => input(state)), { ...(context === undefined ? {} : { context }), ...batch })
    },
  })
}
