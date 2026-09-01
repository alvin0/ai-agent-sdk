/**
 * Asking permission before a tool runs.
 *
 * The shape is the one both reference implementations arrived at: the loop does
 * not pause, the *tool call* pauses. A pending promise is parked in a map keyed by
 * call id, a request is published, and whoever is watching resolves it later by
 * that id. Everything else in the turn — other tool calls in the same batch,
 * streaming, cancellation — keeps working.
 *
 * Two details are load-bearing and easy to get wrong:
 *
 * 1. **The waiter is registered BEFORE the request is published.** A listener that
 *    resolves synchronously (a policy engine, a test) would otherwise answer a
 *    question nobody is holding, and the call would hang forever.
 * 2. **`deny` and `abort` are different outcomes.** Denial is a normal answer that
 *    the model should see and can work around. Abort is the user withdrawing the
 *    whole turn. Collapsing them either strands a cancelled run waiting for the
 *    model to react, or teaches the model that "no" means "stop everything".
 *
 * @module ai-agent-sdk/agent/tool/approval
 */

import type { ToolCallId } from '@ai-agent-sdk/core'
import { detachedFrozen } from '@ai-agent-sdk/core'

/** What the approver decided. */
export type ApprovalDecision =
  /** Run it. */
  | 'allow'
  /** Refuse this call; the model is told and may try something else. */
  | 'deny'
  /** Withdraw the turn entirely. */
  | 'abort'

/** One request for permission. */
export interface ApprovalRequest {
  /** Provider-issued id of the call awaiting a decision. */
  readonly callId: ToolCallId
  readonly toolName: string
  /** Parsed arguments, so an approver can show what is about to happen. */
  readonly args: unknown
  /** Why permission is being asked, when an interceptor said. */
  readonly reason?: string
  readonly turn: number
  readonly step: number
}

/** Decides whether a call may proceed. */
export interface ApprovalBroker {
  /**
   * Ask for permission.
   * @param request - what is about to run.
   * @param signal - cancellation; an abort must settle the promise, not leak it.
   * @returns the decision.
   */
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>
}

/**
 * A broker that answers every request the same way, without asking anyone.
 *
 * For headless runs and tests. `deny` is a useful default for a sandbox that wants
 * approval-requiring tools reported to the model as unavailable rather than
 * silently executed.
 * @param decision - the fixed answer.
 * @returns the broker.
 */
export function fixedApprovalBroker(decision: ApprovalDecision): ApprovalBroker {
  return { request: () => Promise.resolve(decision) }
}

/**
 * A broker that publishes requests and waits to be answered by call id.
 *
 * This is the interactive one. Wire {@link InteractiveApprovalBroker.onRequest} to
 * a UI, and call {@link InteractiveApprovalBroker.resolve} when the human answers.
 */
export interface InteractiveApprovalBroker extends ApprovalBroker {
  /** Requests still awaiting an answer, in the order they were asked. */
  pending(): readonly ApprovalRequest[]
  /**
   * Observe requests.
   *
   * Listeners are invoked AFTER the waiter is registered, so resolving
   * synchronously from inside a listener is safe.
   * @param listener - receives each request.
   * @returns a disposer.
   */
  onRequest(listener: (request: ApprovalRequest) => void): () => void
  /**
   * Answer a pending request.
   * @param callId - the call to answer.
   * @param decision - the answer.
   * @returns true when a pending request was answered; false when the id is
   *   unknown, which happens legitimately if the turn was already cancelled.
   */
  resolve(callId: ToolCallId, decision: ApprovalDecision): boolean
  /**
   * Answer every outstanding request with `abort`.
   *
   * Call this when a turn is torn down: a parked promise with no answer coming
   * would keep the run alive forever.
   */
  abortAll(): void
}

export interface InteractiveApprovalBrokerOptions {
  /** Maximum requests parked across concurrent sessions. Defaults to 1,024. */
  readonly maxPending?: number
}

interface Waiter {
  readonly request: ApprovalRequest
  readonly settle: (decision: ApprovalDecision) => void
}

/**
 * Create an interactive approval broker.
 * @returns the broker.
 */
export function createApprovalBroker(options: InteractiveApprovalBrokerOptions = {}): InteractiveApprovalBroker {
  const maxPending = positiveSafeInteger(options.maxPending ?? 1_024, 'approval maxPending')
  const waiters = new Map<ToolCallId, Waiter>()
  const listeners = new Set<(request: ApprovalRequest) => void>()

  return {
    request(request, signal) {
      if (signal?.aborted === true) return Promise.resolve('abort')
      if (waiters.has(request.callId)) {
        return Promise.reject(new Error(`approval request '${request.callId}' is already pending`))
      }
      if (waiters.size >= maxPending) {
        return Promise.reject(new Error(`approval broker reached its ${maxPending}-request limit`))
      }
      const published = detachedFrozen(request)

      return new Promise<ApprovalDecision>((resolve) => {
        let settled = false
        const settle = (decision: ApprovalDecision): void => {
          if (settled) return
          settled = true
          waiters.delete(request.callId)
          signal?.removeEventListener('abort', onAbort)
          resolve(decision)
        }
        function onAbort(): void {
          settle('abort')
        }

        // Registered first, deliberately: a listener below may answer
        // synchronously, and there has to be somewhere for that answer to land.
        waiters.set(request.callId, { request: published, settle })
        signal?.addEventListener('abort', onAbort, { once: true })

        for (const listener of [...listeners]) {
          try {
            listener(published)
          } catch {
            // A broken observer must not strand the call. If nobody else answers,
            // cancellation or `abortAll` still settles it.
          }
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

    resolve(callId, decision) {
      const waiter = waiters.get(callId)
      if (waiter === undefined) return false
      waiter.settle(decision)
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
