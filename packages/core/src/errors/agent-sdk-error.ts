/**
 * Error taxonomy: a stable machine-routable `code` beside the human-readable
 * `message`, plus the wording classifiers adapters share.
 *
 * The taxonomy is a string `code`, deliberately NOT a TypeScript enum, so a
 * third-party adapter can introduce its own code without a core release. Route
 * on `code`; never parse `message`.
 *
 * @module ai-agent-sdk/core/errors/agent-sdk-error
 */

/**
 * Base class for every error this SDK raises. Carries a stable `code` and
 * supports `cause` chaining through the standard `ErrorOptions`.
 */
export class AgentSdkError extends Error {
  /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never on `message`. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** A request was rejected because it exceeded the model's context window. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** The account's quota, balance, or credit is exhausted  Enot a transient rate limit. */
export const QUOTA_EXCEEDED_CODE = 'QUOTA'

/**
 * The response completed normally but carried no content at all.
 *
 * Providers occasionally emit a degenerate completion: a terminal stop with
 * zero output. Adapters classify that as this failure rather than yielding an
 * empty assistant message, because an empty message silently ends the turn with
 * nothing for the caller or the agent loop to act on. Nothing durable was
 * produced, so this IS in the default retryable set.
 */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/** No credential was available anywhere for the request. */
export const MISSING_CREDENTIAL_CODE = 'MISSING_CREDENTIAL'

/**
 * A credential was supplied but cannot be used  Emalformed, not absent.
 *
 * Distinct from {@link MISSING_CREDENTIAL_CODE} because the fix differs: correct
 * the stored value rather than supply one. Deliberately outside the default
 * retryable set, since a malformed credential fails identically every time.
 */
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'

/** Structured codes and phrases that explicitly name a context bound being exceeded. */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
)

/** Request-size wording that ties "too large" directly to model context capacity. */
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
)

/** "Exceeds" wording is only safe to classify when its object is explicitly the model context. */
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
)

/**
 * Recognize context-overflow wording.
 *
 * Both providers report this as a generic HTTP 400, so status alone cannot
 * separate "your prompt is too long" (worth compacting and retrying) from
 * "your request is malformed" (worth failing). The classifier is deliberately
 * narrow: it only fires when the wording names the context window, because a
 * false positive would make the caller compact history to fix a schema bug.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true when the detail identifies a request exceeding the model context window.
 */
export function isContextWindowExceededError(detail: string): boolean {
  return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || TOO_LARGE_FOR_CONTEXT.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || EXCEEDS_MODEL_CONTEXT.test(detail)
}

/**
 * Recognize an exhausted account quota rather than a transient request-rate limit.
 *
 * The distinction matters because both can arrive as HTTP 429 and their retry
 * behaviour is opposite: a rate limit clears on its own, a spent balance never
 * does. Checked BEFORE the 429 mapping for that reason.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true only for terminal quota, balance, credit, budget, or usage-limit wording.
 */
export function isQuotaExceededError(detail: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

/**
 * Render a thrown value with its full `cause` chain and `AggregateError` members.
 *
 * Transport wrappers are the motivation: undici surfaces a bare
 * `TypeError: fetch failed` whose actual reason (DNS, TLS, ECONNRESET) lives
 * only in `cause`. Diagnostic surfaces only  Enever parse the result; route on
 * {@link AgentSdkError.code}.
 * @param value - the caught value (`unknown` in catch clauses).
 * @returns the outermost message first, each cause appended with `: ` (skipped
 *   when it repeats the wrapper message verbatim), and AggregateError members
 *   bracketed and `; `-joined.
 */
export function errorChain(value: unknown): string {
  // Tracks the ACTIVE recursion path (entries removed on exit), so only true
  // cycles are flagged and a diamond-shared cause still renders in full.
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, 'message')
          if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
            return descriptor.value
          }
        }
        return String(current)
      }
      const message = current.message === '' ? current.name : current.message
      const members = current instanceof AggregateError && current.errors.length > 0
        ? ` [${current.errors.map(render).join('; ')}]`
        : ''
      const causeText = current.cause === undefined || current.cause === null
        ? ''
        : render(current.cause)
      // Wrappers built as `new AgentSdkError(String(value), code, { cause: value })`
      // repeat their cause verbatim; rendering it twice would only add noise.
      const cause = causeText === '' || causeText === message ? '' : `: ${causeText}`
      return `${message}${members}${cause}`
    } catch {
      // Only hostile coercion reaches here: a throwing toString/Symbol.toPrimitive
      // on a non-Error, or a throwing message/name/cause getter on an Error
      // subclass from a third-party SDK. This renderer feeds logs and user-facing
      // notices, so nothing may escape it. Inner frames catch their own throws,
      // so one hostile node collapses without taking the whole chain with it.
      return '<unrenderable value>'
    } finally {
      path.delete(current)
    }
  }
  return render(value)
}

/**
 * Narrow an arbitrary thrown value to an {@link AgentSdkError}.
 * @param value - the caught value (`unknown` in catch clauses).
 * @returns true only for real instances; duck-typed or cross-realm errors do not narrow.
 */
export function isAgentSdkError(value: unknown): value is AgentSdkError {
  return value instanceof AgentSdkError
}
