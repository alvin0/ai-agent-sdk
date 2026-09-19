/** Fold extra query parameters onto a request path, resolving a function form first. */
export function appendQuery(
  path: string,
  query: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>) | undefined,
): string {
  const resolved = typeof query === 'function' ? query() : query
  if (resolved === undefined) return path
  const params = new URLSearchParams(resolved).toString()
  if (params.length === 0) return path
  return `${path}${path.includes('?') ? '&' : '?'}${params}`
}
