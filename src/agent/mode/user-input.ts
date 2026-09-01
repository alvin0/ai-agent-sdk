/** Human input as a resumable, call-id-addressed boundary. */

import type { ToolCallId } from '../../core/primitives/brand.ts'
import { detachedFrozen } from '../../core/primitives/snapshot.ts'

export interface UserInputOption {
  /** Short text shown on the choice button. */
  readonly label: string
  /** One sentence explaining the consequence or trade-off. */
  readonly description: string
}

export interface UserInputQuestion {
  /** Stable snake_case key used to map the answer. */
  readonly id: string
  /** Compact UI heading (12 characters or fewer is recommended). */
  readonly header: string
  /** The single question shown to the user. */
  readonly question: string
  /** Two or three mutually exclusive suggestions. Free-form input is separate. */
  readonly options: readonly UserInputOption[]
  /** A UI should offer a free-form answer in addition to the suggestions. */
  readonly allowFreeForm: true
}

export interface UserInputRequest {
  /** The provider tool-call id is the durable correlation id. */
  readonly requestId: ToolCallId
  readonly callId: ToolCallId
  readonly turn: number
  readonly step: number
  readonly questions: readonly UserInputQuestion[]
  readonly isBlocking: true
}

export interface UserInputAnswer {
  /** One or more selected labels or free-form strings. */
  readonly answers: readonly string[]
}

export interface UserInputResponse {
  /** Answers keyed by {@link UserInputQuestion.id}. */
  readonly answers: Readonly<Record<string, UserInputAnswer>>
}

export type UserInputDecision = UserInputResponse | 'abort'

export interface UserInputBroker {
  request(request: UserInputRequest, signal?: AbortSignal): Promise<UserInputDecision>
}

export interface InteractiveUserInputBroker extends UserInputBroker {
  pending(): readonly UserInputRequest[]
  onRequest(listener: (request: UserInputRequest) => void): () => void
  resolve(requestId: ToolCallId, response: UserInputResponse): boolean
  abortAll(): void
}

export interface InteractiveUserInputBrokerOptions {
  /** Maximum requests parked across concurrent sessions. Defaults to 1,024. */
  readonly maxPending?: number
}

interface Waiter {
  readonly request: UserInputRequest
  readonly settle: (decision: UserInputDecision) => void
}

/**
 * Create a broker for GUIs and CLIs that pause one tool call and resume it by id.
 * The waiter is installed before listeners run, so a synchronous listener is safe.
 */
export function createUserInputBroker(options: InteractiveUserInputBrokerOptions = {}): InteractiveUserInputBroker {
  const maxPending = positiveSafeInteger(options.maxPending ?? 1_024, 'user-input maxPending')
  const waiters = new Map<ToolCallId, Waiter>()
  const listeners = new Set<(request: UserInputRequest) => void>()

  return {
    request(request, signal) {
      if (signal?.aborted === true) return Promise.resolve('abort')
      if (waiters.has(request.requestId)) {
        return Promise.reject(new Error(`user-input request '${request.requestId}' is already pending`))
      }
      if (waiters.size >= maxPending) {
        return Promise.reject(new Error(`user-input broker reached its ${maxPending}-request limit`))
      }
      const published = detachedFrozen(request)
      return new Promise<UserInputDecision>((resolve) => {
        let settled = false
        const settle = (decision: UserInputDecision): void => {
          if (settled) return
          settled = true
          waiters.delete(request.requestId)
          signal?.removeEventListener('abort', onAbort)
          resolve(decision)
        }
        function onAbort(): void { settle('abort') }

        waiters.set(request.requestId, { request: published, settle })
        signal?.addEventListener('abort', onAbort, { once: true })
        for (const listener of [...listeners]) {
          try { listener(published) } catch { /* observers do not own the waiter */ }
        }
      })
    },

    pending() {
      return [...waiters.values()].map(waiter => waiter.request)
    },

    onRequest(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    resolve(requestId, response) {
      const waiter = waiters.get(requestId)
      if (waiter === undefined) return false
      waiter.settle(detachedFrozen(response))
      return true
    },

    abortAll() {
      for (const waiter of [...waiters.values()]) waiter.settle('abort')
    },
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`)
  return value
}

/** A headless broker useful for policy-driven runs and tests. */
export function fixedUserInputBroker(
  response: UserInputResponse | ((request: UserInputRequest) => UserInputDecision | Promise<UserInputDecision>),
): UserInputBroker {
  return {
    request: request => Promise.resolve(typeof response === 'function' ? response(request) : response),
  }
}
