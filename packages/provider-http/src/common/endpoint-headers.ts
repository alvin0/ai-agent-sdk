import { mergeHeaderLayers } from './header-layers.ts'

/**
 * What a context-aware `headers` function receives.
 *
 * No `model` here: headers resolve once per connection at `connect()` time,
 * which a route may reuse across several models — carrying `model` would
 * imply a per-request guarantee this layer cannot make. `transformRequest`'s
 * `RequestContext` is the place for a model-scoped hook.
 */
export interface HeaderContext {
  /** Registered provider route. */
  readonly provider: string
  /** Stable code-owned agent identity, when this call belongs to one and the caller supplied it. */
  readonly agentId?: string
  readonly signal?: AbortSignal
}

/** Capture custom endpoint headers per operation, rejecting reserved names and collisions. */
export function endpointHeaders(
  headers: Readonly<Record<string, string>> | ((ctx: HeaderContext) => Readonly<Record<string, string>>) | undefined,
  defaults: Readonly<Record<string, string>> = {},
): (ctx: HeaderContext) => Readonly<Record<string, string>> {
  const fixedDefaults = mergeHeaderLayers([{ layer: 'endpoint', headers: defaults }]).headers
  const capture = (value: Readonly<Record<string, string>>) => mergeHeaderLayers([
    { layer: 'endpoint', headers: fixedDefaults },
    { layer: 'endpoint', headers: value },
  ]).headers
  if (typeof headers === 'function') return ctx => capture(headers(ctx))
  const fixed = capture(headers ?? {})
  return () => fixed
}
