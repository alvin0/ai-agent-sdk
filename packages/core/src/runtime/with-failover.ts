/**
 * Failover as an adapter DECORATOR: one route served by an ordered list of
 * members — accounts of one provider, or different providers — so one expired
 * credential, exhausted quota or outage does not take the system down.
 *
 * It follows the same rule as {@link withRetry}: a call moves to the next member
 * only while nothing but provisional usage has reached the consumer. A failure
 * after content was streamed is forwarded; re-running it elsewhere would replay
 * that content.
 *
 * A member that fails is cooled down (skipped by later calls) for a time that
 * depends on the failure, and calls return to the first member as soon as its
 * cooldown ends. When every member is cooling down, a call still tries them,
 * soonest-recovering first, so the route never refuses to try.
 *
 * Replay state (e.g. a provider's encrypted reasoning) is tagged with the member
 * that produced it and given back only to that member: another account or
 * provider gets the history without it.
 *
 * @module ai-agent-sdk/core/runtime/with-failover
 */

import { ModelAdapter, type PreparedAdapterCall } from '../contract/adapter.ts'
import type { GenerateOptions } from '../contract/generate-options.ts'
import type { ModelInfo, ProviderInfo, ResolvedModelInfo } from '../contract/model-info.ts'
import { CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '../errors/agent-sdk-error.ts'
import { normalizeModelFailure, type ModelFailure } from '../errors/failure.ts'
import { MODEL_ERROR_CODES } from '../errors/model-error.ts'
import { freezeMessage, type Message } from '../message/message.ts'
import type { ModelInvocationContext } from '../observation/report.ts'
import { systemMonotonicNow } from '../platform/adapter.ts'
import type { ReplayEnvelope, StreamChunk } from '../stream/chunk.ts'
import { RetryAttemptRunner } from './retry-attempt.ts'

/** One way to serve the failover route. */
export interface FailoverMember {
  /** The adapter serving this member. */
  readonly adapter: ModelAdapter
  /** Route the adapter serves this member under. */
  readonly provider: string
  /** Model id to request from this member; defaults to the requested id. */
  readonly model?: string
  /** Name in failover events, and the key its replay state is kept under; defaults to `provider`. Distinct. */
  readonly id?: string
}

/** A call left one member for the next. */
export interface FailoverEvent {
  /** The failover route. */
  readonly provider: string
  /** Member that failed. */
  readonly from: string
  /** Member tried next; `undefined` when none is left for this call. */
  readonly to: string | undefined
  readonly failure: ModelFailure
  /** How long later calls skip the failed member. */
  readonly cooldownMs: number
}

/** Options for {@link withFailover}. */
export interface WithFailoverOptions {
  /** Provider name reported for the route. */
  readonly displayName?: string
  /**
   * Whether a failure moves the call to the next member. Defaults to every
   * failure except cancellation and a request no member could accept (invalid
   * request, context window exceeded). When the first member tried fails this
   * way the call ends; a later member failing this way is skipped without a
   * cooldown (it may only differ from the first), and the earlier failure is reported.
   */
  readonly shouldFailover?: (failure: ModelFailure) => boolean
  /** How long later calls skip a member after this failure; see {@link FAILOVER_POLICY}. */
  readonly cooldownMs?: (failure: ModelFailure) => number
  /** Observe each switch, for logging and alerting. Must not throw (a throw is ignored). */
  readonly onFailover?: (event: FailoverEvent) => void
  /** Monotonic clock in milliseconds; injectable for tests. */
  readonly now?: () => number
}

/** Default member cooldowns. A provider's `retry-after` wins for quota and rate limits. */
export const FAILOVER_POLICY = Object.freeze({
  /** Credentials rejected or unavailable: re-checked after this long (e.g. after a re-login). */
  authCooldownMs: 5 * 60_000,
  /** Quota or usage limit exhausted. */
  quotaCooldownMs: 15 * 60_000,
  rateLimitCooldownMs: 30_000,
  /** Server, network, timeout and anything else. */
  transientCooldownMs: 10_000,
  maxCooldownMs: 24 * 60 * 60_000,
})

const NOT_FAILOVER = new Set<string>([
  MODEL_ERROR_CODES.ABORTED, MODEL_ERROR_CODES.TEARDOWN_TIMEOUT, MODEL_ERROR_CODES.INVALID_REQUEST,
  CONTEXT_WINDOW_EXCEEDED_CODE,
])

/** The default {@link WithFailoverOptions.shouldFailover}. */
export function defaultShouldFailover(failure: ModelFailure): boolean { return !NOT_FAILOVER.has(failure.code) }

/** The default {@link WithFailoverOptions.cooldownMs}. */
export function defaultFailoverCooldownMs(failure: ModelFailure): number {
  const code = failure.code
  if (code === QUOTA_EXCEEDED_CODE) return failure.providerRetryAfterMs ?? FAILOVER_POLICY.quotaCooldownMs
  if (code === MODEL_ERROR_CODES.RATE_LIMIT) return failure.providerRetryAfterMs ?? FAILOVER_POLICY.rateLimitCooldownMs
  // Credential failures surface under provider-specific codes (re-auth required, missing credentials),
  // but a lock, conflict, limit or transient failure while handling credentials is not a rejected login.
  if (code === MODEL_ERROR_CODES.AUTH
    || (/AUTH|CREDENTIAL|TOKEN/.test(code) && !/CONFLICT|LOCK|TRANSIENT|TIMEOUT|LIMIT/.test(code))) {
    return FAILOVER_POLICY.authCooldownMs
  }
  return FAILOVER_POLICY.transientCooldownMs
}

/** Key under which a member's replay state records the member that produced it. */
const REPLAY_MEMBER_KEY = 'ai-agent-sdk.failover'

interface PreparedMember {
  readonly index: number
  readonly prepared: PreparedAdapterCall
}

class FailoverAdapter extends ModelAdapter {
  private readonly members: readonly FailoverMember[]
  private readonly options: WithFailoverOptions
  /** Monotonic time until which each member is skipped. */
  private readonly coolingUntil: number[]
  /** Times each member was cooled down, so a call that started before one does not clear it. */
  private readonly trips: number[]

  constructor(members: readonly FailoverMember[], options: WithFailoverOptions) {
    super()
    if (members.length === 0) throw new TypeError('withFailover requires at least one member')
    // The id keys each member's replay state: two accounts behind one route need their own ids.
    if (new Set(members.map(member => member.id ?? member.provider)).size !== members.length) {
      throw new TypeError('withFailover members need distinct ids (set `id` for members sharing a provider)')
    }
    this.members = Object.freeze([...members])
    this.options = options
    this.coolingUntil = members.map(() => 0)
    this.trips = members.map(() => 0)
  }

  override providerInfo(provider: string): ProviderInfo {
    return { id: provider, name: this.options.displayName ?? provider }
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    for (const index of this.order()) {
      const member = this.members[index]!
      try {
        const models = await member.adapter.listModels(member.provider, signal)
        if (models.length > 0) return models.map(model => ({ ...model, provider }))
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error
        // Otherwise the next member may answer.
      }
    }
    return []
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedModelInfo> {
    let failure: unknown
    for (const index of this.order()) {
      const member = this.members[index]!
      try {
        const resolved = await member.adapter.resolveModel(member.provider, member.model ?? model, signal)
        return { ...resolved, provider, id: model }
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error
        failure = error
      }
    }
    throw failure
  }

  override async prepareCall(
    provider: string, model: string, signal?: AbortSignal, context?: ModelInvocationContext,
  ): Promise<PreparedAdapterCall> {
    const tried = new Set<number>()
    let failure: { readonly error: unknown } | undefined
    for (const index of this.order()) {
      const member = this.members[index]!
      tried.add(index)
      try {
        const prepared = await member.adapter.prepareCall(member.provider, member.model ?? model, signal, context)
        const first: PreparedMember = { index, prepared }
        return {
          model: { ...prepared.model, provider, id: model },
          stream: (options, invocation = context) => this.failoverStream(options, invocation, first),
        }
      } catch (error: unknown) {
        const normalized = normalizeModelFailure(error)
        if (signal?.aborted === true) throw error
        if (!this.eligible(normalized)) {
          // Ends the call on the first member; a later one is skipped (see shouldFailover).
          if (failure === undefined) throw error
          continue
        }
        failure ??= { error }
        this.trip(provider, index, normalized, this.order().find(next => !tried.has(next)))
      }
    }
    throw failure!.error
  }

  stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    return this.failoverStream(options, context, undefined)
  }

  private async * failoverStream(
    options: GenerateOptions, context: ModelInvocationContext | undefined, first: PreparedMember | undefined,
  ): AsyncGenerator<StreamChunk> {
    // Priority order as of now, not as of preparing: a member may have recovered or been cooled down
    // since. The prepared member reuses its prepared call when its turn comes.
    const order = this.order()
    let failure: ModelFailure | undefined
    for (let position = 0; position < order.length; position++) {
      const index = order[position]!
      const trips = this.trips[index]
      const attempt = yield* new RetryAttemptRunner({})
        .runAttempt(this.memberRequest(options, index), this.dispatcher(index, context, first))
      if (attempt.kind === 'forward') {
        // A failure another call saw while this one ran is newer news than this success.
        if (this.trips[index] === trips) this.coolingUntil[index] = 0
        for await (const chunk of attempt.chunks) yield tagReplay(chunk, this.memberId(index))
        return
      }
      if (aborted(options, attempt.failure)) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: attempt.failure } }
        return
      }
      const next = this.afterFailure(options.provider, attempt.failure, failure === undefined,
        { index, next: order[position + 1] })
      if (next === 'skip') continue
      failure ??= attempt.failure
      if (next === 'stop') break
    }
    yield { type: 'finish', reason: { kind: 'error', failure: failure! } }
  }

  /**
   * After a member failed: `next` cools it down and moves on. An ineligible failure
   * (see shouldFailover) ends the call on the first member tried (`stop`); a later
   * member failing that way is skipped without a cooldown (`skip`).
   */
  private afterFailure(
    provider: string, failure: ModelFailure, firstFailure: boolean,
    step: { readonly index: number; readonly next: number | undefined },
  ): 'next' | 'stop' | 'skip' {
    if (!this.eligible(failure)) return firstFailure ? 'stop' : 'skip'
    this.trip(provider, step.index, failure, step.next)
    return 'next'
  }


  /** The call as one member receives it: its route and model, and only its own replay state. */
  private memberRequest(options: GenerateOptions, index: number): GenerateOptions {
    const member = this.members[index]!
    return {
      ...options, provider: member.provider, model: member.model ?? options.model,
      messages: memberHistory(options.messages, this.memberId(index)),
    }
  }

  /** The prepared call for the member it was prepared on; any other member is prepared when reached. */
  private dispatcher(index: number, context: ModelInvocationContext | undefined, first: PreparedMember | undefined,
  ): (request: GenerateOptions) => AsyncIterable<StreamChunk> {
    if (index === first?.index) return request => first.prepared.stream(request, context)
    const member = this.members[index]!
    return request => prepareAndStream(member, request, context)
  }

  /** Members not cooling down in priority order, then cooling ones, soonest-recovering first. */
  private order(): number[] {
    const now = this.now()
    const indexes = this.members.map((_member, index) => index)
    const ready = indexes.filter(index => this.coolingUntil[index]! <= now)
    const cooling = indexes.filter(index => this.coolingUntil[index]! > now)
      .sort((left, right) => this.coolingUntil[left]! - this.coolingUntil[right]!)
    return [...ready, ...cooling]
  }

  private eligible(failure: ModelFailure): boolean {
    try { return (this.options.shouldFailover ?? defaultShouldFailover)(failure) } catch { return false }
  }

  private trip(provider: string, index: number, failure: ModelFailure, next: number | undefined): void {
    let cooldownMs: number
    try { cooldownMs = (this.options.cooldownMs ?? defaultFailoverCooldownMs)(failure) } catch { cooldownMs = 0 }
    cooldownMs = Number.isFinite(cooldownMs) ? Math.min(Math.max(cooldownMs, 0), FAILOVER_POLICY.maxCooldownMs) : 0
    // Concurrent calls can trip one member with different failures: the longest cooldown holds.
    this.coolingUntil[index] = Math.max(this.coolingUntil[index]!, this.now() + cooldownMs)
    this.trips[index]!++
    try {
      this.options.onFailover?.({
        provider, from: this.memberId(index), to: next === undefined ? undefined : this.memberId(next), failure,
        cooldownMs,
      })
    } catch { /* observers do not own availability */ }
  }

  private memberId(index: number): string {
    const member = this.members[index]!
    return member.id ?? member.provider
  }

  private now(): number { return (this.options.now ?? systemMonotonicNow)() }
}

function aborted(options: GenerateOptions, failure: ModelFailure): boolean {
  return options.signal?.aborted === true || failure.code === MODEL_ERROR_CODES.ABORTED
}

/** Tag a successful response's replay state with the member that produced it. */
function tagReplay(chunk: StreamChunk, memberId: string): StreamChunk {
  if (chunk.type !== 'finish' || chunk.replayState === undefined) return chunk
  return { ...chunk, replayState: { ...chunk.replayState,
    response: { [REPLAY_MEMBER_KEY]: memberId, response: chunk.replayState.response } } }
}

/** The history as one member sees it: its own replay state untagged, anyone else's removed. */
function memberHistory(messages: readonly Message[], memberId: string): readonly Message[] {
  let changed = false
  const projected = messages.map((message) => {
    const source = message.source
    if (message.role !== 'assistant' || source.kind !== 'model' || source.replayState === undefined) return message
    changed = true
    const own = memberReplay(source.replayState, memberId)
    return freezeMessage({ ...message, source: own === undefined
      ? { kind: 'model', provider: source.provider, model: source.model }
      : { ...source, replayState: own } })
  })
  return changed ? projected : messages
}

function memberReplay(state: unknown, memberId: string): ReplayEnvelope | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const envelope = state as ReplayEnvelope
  const tagged = envelope.response as Record<string, unknown> | null | undefined
  if (typeof tagged !== 'object' || tagged === null || tagged[REPLAY_MEMBER_KEY] !== memberId) return undefined
  return { ...envelope, response: tagged.response }
}

async function * prepareAndStream(
  member: FailoverMember, options: GenerateOptions, context: ModelInvocationContext | undefined,
): AsyncGenerator<StreamChunk> {
  const prepared = await member.adapter.prepareCall(member.provider, options.model, options.signal, context)
  yield* prepared.stream(options, context)
}

/**
 * Serve one route from an ordered list of adapters, moving a call to the next
 * member when one fails before streaming content (expired or rejected
 * credentials, exhausted quota, rate limit, outage). Members should serve
 * equivalent models: a call keeps the request it was built for.
 * @param members - in priority order; the first available one serves each call.
 * @param options - failover and cooldown policy, and an observer.
 * @returns an adapter to register under the failover route.
 */
export function withFailover(members: readonly FailoverMember[], options: WithFailoverOptions = {}): ModelAdapter {
  return new FailoverAdapter(members, options)
}
