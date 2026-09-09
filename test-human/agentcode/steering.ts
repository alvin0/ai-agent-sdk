/** Safe-step steering queue for a long-running agentcode session. */

import type { History } from '@ai-agent-sdk/core/agent'
import type { TurnHooks } from '@ai-agent-sdk/core/agent'
import { createUserMessage } from '@ai-agent-sdk/core'

export interface SteeringItem {
  readonly id: string
  readonly text: string
  readonly queuedAt: string
}

export type SteeringBoundary =
  | { readonly kind: 'before-step'; readonly turn: number; readonly step: number }
  | { readonly kind: 'turn-end' }

export interface AgentCodeSteeringOptions {
  readonly onApplied?: (
    items: readonly SteeringItem[],
    boundary: SteeringBoundary,
  ) => void
}

/** Accept input at any time and append it only at model-safe boundaries. */
export class AgentCodeSteeringQueue {
  private readonly pending: SteeringItem[] = []
  private readonly options: AgentCodeSteeringOptions

  constructor(options: AgentCodeSteeringOptions = {}) {
    this.options = options
  }

  enqueue(text: string): SteeringItem {
    const normalized = text.trim()
    if (normalized.length === 0) throw new Error('steering text must be non-empty')
    const item = Object.freeze({
      id: newSteeringId(),
      text: normalized,
      queuedAt: new Date().toISOString(),
    })
    this.pending.push(item)
    return item
  }

  pendingCount(): number { return this.pending.length }

  hooks(history: () => History): TurnHooks {
    return {
      beforeStep: context => {
        this.apply(history(), {
          kind: 'before-step', turn: context.turn, step: context.step,
        })
        return { kind: 'proceed' }
      },
      onTurnEnd: context => {
        // Appending here makes runTurn continue instead of publishing a stale
        // final answer when steering arrived during the last provider stream.
        // If the loop is terminal, leave the input queued so the CLI can carry
        // it into a real next turn instead of reporting an unobserved append.
        if (context.canContinue) this.apply(history(), { kind: 'turn-end' })
      },
    }
  }

  /** Carry input that missed the final safe boundary into a new user turn. */
  takePendingInput(): string | undefined {
    if (this.pending.length === 0) return undefined
    const items = this.pending.splice(0)
    return items.map(item => item.text).join('\n\n')
  }

  private apply(history: History, boundary: SteeringBoundary): void {
    if (this.pending.length === 0) return
    const items = this.pending.splice(0)
    for (const item of items) {
      history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'agentcode-steering' },
        content: [{ type: 'text', text: item.text }],
      }) })
    }
    this.options.onApplied?.(Object.freeze(items), boundary)
  }
}

function newSteeringId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
