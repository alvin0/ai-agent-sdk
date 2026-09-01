/**
 * Exhaustiveness helper for CLOSED unions.
 *
 * Use {@link assertNever} in the default branch of a switch over a closed union
 * so that adding a variant fails compilation at every site that must handle it.
 * Do NOT use it for the merge-extensible unions (`ContentBlock`, `FinishReason`,
 * `MessageSource`): a consumer may legitimately receive a variant it does not
 * know, so those switches must fall through instead of throwing.
 *
 * @module ai-agent-sdk/core/primitives/never
 */

/**
 * Mark an unreachable closed-union branch.
 * @param value - the impossible value; typed `never` so an unhandled variant fails at the call site.
 * @param context - optional label (usually the switch site) prefixed into the message.
 * @returns never  Ealways throws, rendering the offending value.
 */
export function assertNever(value: never, context?: string): never {
  // JSON.stringify is typed `string` but returns undefined for `undefined`;
  // String() covers that and other non-serializable escapes.
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant${context === undefined ? '' : ` in ${context}`}: ${rendered}`)
}
