/** Optional request sinks can be absent without changing the public adapter declaration. */
const unread = new WeakSet<object>()

export function markRequestLogUnread(adapter: object): void {
  unread.add(adapter)
}

export function isRequestLogUnread(adapter: object): boolean {
  return unread.has(adapter)
}
