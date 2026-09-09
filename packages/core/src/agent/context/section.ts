/**
 * Validation and the turn-scoped reconciler for {@link ContextSection}.
 *
 * @module ai-agent-sdk/core/agent/context/section
 */

import { createUserMessage } from '../../message/index.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import type { SdkLogger } from '../../logging/types.ts'
import type { History } from '../history/history.ts'
import type {
  ContextSection, ContextSectionResolveInput, ContextSectionScope, ContextSectionState,
  ContextToolTouch,
} from './types.ts'

export const CONTEXT_SECTION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const CONTEXT_SECTION_INVALID = 'CONTEXT_SECTION_INVALID'
/** Ceiling for one section's rendered text. A section budgets its own content below this. */
export const MAX_CONTEXT_SECTION_TEXT_BYTES = 262_144
/** Message-source producer prefix that identifies a section's own surface node. */
export const CONTEXT_SECTION_PRODUCER_PREFIX = 'context-section:'

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Capture one section after checking the parts the loop depends on.
 * @param input - the authored section.
 * @returns a frozen section with its `resolve` bound to the authored object.
 */
export function defineContextSection(input: ContextSection): ContextSection {
  if (typeof input.id !== 'string' || !CONTEXT_SECTION_ID_PATTERN.test(input.id)) {
    throw new AgentSdkError(
      `context section id must be kebab-case, received '${String(input.id)}'`,
      CONTEXT_SECTION_INVALID,
    )
  }
  if (typeof input.resolve !== 'function') {
    throw new AgentSdkError(`context section '${input.id}' must supply resolve()`, CONTEXT_SECTION_INVALID)
  }
  const resolve = input.resolve.bind(input)
  return Object.freeze({
    id: input.id,
    resolve,
    ...input.retractionText === undefined ? {} : { retractionText: input.retractionText },
  })
}

/**
 * Reject duplicate ids once, at assembly, rather than per step.
 * @param sections - authored sections in surface order.
 * @returns the frozen, validated list.
 */
export function captureContextSections(
  sections: readonly ContextSection[] | undefined,
): readonly ContextSection[] | undefined {
  if (sections === undefined) return undefined
  const seen = new Set<string>()
  const captured = sections.map(section => {
    const validated = defineContextSection(section)
    if (seen.has(validated.id)) {
      throw new AgentSdkError(`duplicate context section '${validated.id}'`, CONTEXT_SECTION_INVALID)
    }
    seen.add(validated.id)
    return validated
  })
  return Object.freeze(captured)
}

function retraction(section: ContextSection): string {
  return section.retractionText
    ?? `The previously provided '${section.id}' context no longer applies.`
}

/**
 * What one section currently has on the model surface.
 *
 * `revision` is absent for a node adopted from an earlier turn: the text is
 * known, its producer's revision key is not, so the first comparison of that
 * turn falls back to comparing the text itself.
 */
interface LiveNode {
  readonly seq: number
  readonly text: string
  readonly revision: string | undefined
  /** True once the node holds a retraction notice rather than section content. */
  readonly retracted: boolean
  /** History replacement generation when this node was written or adopted. */
  readonly generation: number
}

export interface ContextSectionRuntimeOptions {
  readonly sections: readonly ContextSection[]
  readonly history: History
  readonly logger?: SdkLogger
  /** Bounds one resolve the same way a turn hook is bounded. */
  readonly guard?: <T>(pending: Promise<T>, name: string) => Promise<T>
  readonly maxTextBytes?: number
  /** Conversation identity handed to every resolve. */
  readonly scope?: ContextSectionScope
}

/**
 * Keeps each section's single live surface node in step with its content.
 *
 * A failing or over-budget section is skipped for that step with its previous
 * node intact: assembled context is advisory, and losing it must never cost the
 * turn. Every write goes through the same replace-in-place path the tool-budget
 * notice uses, so a section never accumulates stale copies of itself.
 *
 * A runtime lives for one turn, but the surface does not. Before deciding
 * anything, a section whose node may have moved — the first step of a new turn,
 * or any step after a compaction shadowed part of the surface — re-reads the
 * live surface and adopts whatever node it still owns there. Without that, a
 * second turn would append a duplicate copy of context the model can already
 * read, and a compacted-away node would never be rewritten because its revision
 * still matched.
 */
export class ContextSectionRuntime {
  private readonly sections: readonly ContextSection[]
  private readonly history: History
  private readonly logger: SdkLogger | undefined
  private readonly guard: <T>(pending: Promise<T>, name: string) => Promise<T>
  private readonly maxTextBytes: number
  private readonly scope: ContextSectionScope
  private readonly live = new Map<string, LiveNode>()
  private readonly adopted = new Set<string>()

  constructor(options: ContextSectionRuntimeOptions) {
    this.sections = options.sections
    this.history = options.history
    this.logger = options.logger
    this.guard = options.guard ?? (pending => pending)
    this.maxTextBytes = options.maxTextBytes ?? MAX_CONTEXT_SECTION_TEXT_BYTES
    this.scope = Object.freeze(options.scope ?? { agentId: undefined, conversationId: undefined })
  }

  /**
   * Recompute every section and write only what changed.
   * @param step - 0 before the first model round, then one per completed step.
   * @param touches - tool calls committed since the previous reconcile.
   * @param signal - turn cancellation.
   */
  async reconcile(
    step: number,
    touches: readonly ContextToolTouch[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const section of this.sections) {
      if (signal.aborted) return
      const node = this.resync(section.id)
      const input: ContextSectionResolveInput = {
        signal,
        step,
        touches,
        scope: this.scope,
        current: node === undefined || node.retracted || node.revision === undefined
          ? undefined
          : { revision: node.revision, text: node.text },
      }
      let next: ContextSectionState | undefined
      try {
        next = await this.guard(
          Promise.resolve().then(() => section.resolve(input)),
          `context-section:${section.id}`,
        )
      } catch (error: unknown) {
        // Advisory context. A section that throws keeps whatever it last wrote
        // rather than taking the turn down with it.
        this.logger?.warn('context section resolve failed', {
          section: section.id,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      if (next === undefined) {
        // A section that stays retracted must not rewrite the notice on every
        // step; one notice replaces the content and then stands.
        if (node !== undefined && !node.retracted) {
          this.write(section, retraction(section), undefined, true, node.seq)
        }
        continue
      }
      if (typeof next.revision !== 'string' || typeof next.text !== 'string') {
        this.logger?.warn('context section returned an invalid state', { section: section.id })
        continue
      }
      if (node !== undefined && !node.retracted) {
        if (node.revision === next.revision) continue
        if (node.text === next.text) {
          // Same text under a new revision key — an adopted node, or a producer
          // that rekeyed identical content. Record the key; write nothing.
          this.live.set(section.id, { ...node, revision: next.revision })
          continue
        }
      }
      const bytes = byteLength(next.text)
      if (bytes > this.maxTextBytes) {
        this.logger?.warn('context section exceeded its byte ceiling', {
          section: section.id, bytes, maxTextBytes: this.maxTextBytes,
        })
        continue
      }
      this.write(section, next.text, next.revision, false, node?.seq)
    }
  }

  /**
   * Reconcile the tracked node against the surface the model actually reads.
   * @param id - the section's id.
   * @returns the live node, or undefined when the section owns none.
   */
  private resync(id: string): LiveNode | undefined {
    const tracked = this.live.get(id)
    const generation = this.history.generation()
    if (this.adopted.has(id) && tracked?.generation === generation) return tracked
    this.adopted.add(id)
    const producer = `${CONTEXT_SECTION_PRODUCER_PREFIX}${id}`
    // Last wins: a replace reinserts at the original position, so a section that
    // somehow owns two nodes keeps the newest and rewrites over it.
    let found: LiveNode | undefined
    for (const node of this.history.surface()) {
      if (node.message.source.kind !== 'app' || node.message.source.producer !== producer) continue
      const text = node.message.content
        .flatMap(block => block.type === 'text' ? [block.text] : [])
        .join('')
      found = {
        seq: node.seq,
        text,
        // A tracked revision survives only while the node it described is the
        // one still on the surface.
        revision: tracked?.seq === node.seq ? tracked.revision : undefined,
        retracted: tracked?.seq === node.seq ? tracked.retracted : false,
        generation,
      }
    }
    if (found === undefined) this.live.delete(id)
    else this.live.set(id, found)
    return found
  }

  private write(
    section: ContextSection,
    text: string,
    revision: string | undefined,
    retracted: boolean,
    previous: number | undefined,
  ): void {
    const message = createUserMessage({
      source: { kind: 'app', producer: `${CONTEXT_SECTION_PRODUCER_PREFIX}${section.id}` },
      content: [{ type: 'text', text }],
    })
    if (previous !== undefined) {
      // Replacing is best-effort for the same reason the budget notice is:
      // compaction can shadow the earlier node between steps, and a replace
      // whose target left the surface is rejected. Fall through to an append so
      // the model still reads the current content.
      try {
        const seq = this.history.append(
          { kind: 'user', message },
          { op: 'replace', from: previous, to: previous, targets: [previous] },
        ).seq
        this.live.set(section.id, { seq, text, revision, retracted, generation: this.history.generation() })
        return
      } catch {
        this.live.delete(section.id)
      }
    }
    const seq = this.history.append({ kind: 'user', message }).seq
    this.live.set(section.id, { seq, text, revision, retracted, generation: this.history.generation() })
  }
}
