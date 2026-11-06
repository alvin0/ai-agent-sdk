/**
 * Adapters whose `observeResponse` forwards to an optional sink that is not set.
 *
 * Internal on purpose (not re-exported): it lets the base skip retaining raw SSE
 * frames for a record nobody reads, without adding a member to the public
 * `HttpModelAdapter` declaration.
 */
const unread = new WeakSet<object>()

/** Record that this adapter's response log has no reader. */
export function markResponseLogUnread(adapter: object): void {
  unread.add(adapter)
}

/** Whether this adapter's response log was marked as having no reader. */
export function isResponseLogUnread(adapter: object): boolean {
  return unread.has(adapter)
}
