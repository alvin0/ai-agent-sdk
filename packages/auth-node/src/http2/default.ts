/** The transport Node provider plugins use when the caller supplies no `fetch`. */
import { createNodeHttp2Fetch, type NodeHttp2Fetch } from './fetch.ts'

/** Variables the platform `fetch` may route through a proxy; this transport does not read them. */
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

/** Where undici (the platform `fetch`) keeps its global dispatcher: v8+ and v6/v7. */
const GLOBAL_DISPATCHERS = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')]

/** The compatibility wrapper undici v8 mirrors its dispatcher through; it adds no routing of its own. */
const DISPATCHER_WRAPPER = 'Dispatcher1Wrapper'

let shared: NodeHttp2Fetch | undefined
let routed: typeof globalThis.fetch | undefined

/** The global `fetch` as this module first saw it, and whether it was the runtime's own. */
const LOADED_FETCH = Object.freeze({ fetch: globalThis.fetch as unknown, builtin: isBuiltinFetch(globalThis.fetch) })

/**
 * One process-wide HTTP/2 transport, like the platform's global dispatcher: every
 * Node plugin shares its per-origin sessions, idle sessions close themselves and
 * never hold the process open, so it needs no owner to close it.
 *
 * Returns `undefined` (keep the platform `fetch`) when a proxy is configured in the
 * environment, because requests through this transport would bypass the proxy.
 * Each request also goes through the global `fetch` while the application has
 * replaced it (MSW, `vi.stubGlobal`, nock, fetch instrumentation, …) or installed
 * a global dispatcher of its own (`setGlobalDispatcher` with a proxy, custom TLS,
 * a mock, …), which this transport would otherwise bypass.
 */
export function defaultNodeFetch(env: NodeJS.ProcessEnv = process.env): typeof globalThis.fetch | undefined {
  if (PROXY_ENV.some(name => (env[name] ?? '').trim() !== '')) return undefined
  shared ??= createNodeHttp2Fetch({ fallback: async (input, init) => await platformFetch()(input, init) })
  const transport = shared
  routed ??= (async (input, init) => {
    const platform = platformFetch()
    return await (globalFetchReplaced(platform) || customGlobalDispatcher()
      ? platform(input, init)
      : transport(input, init))
  }) as typeof globalThis.fetch
  return routed
}

/**
 * The `fetch` that requests leaving this transport go through: the global one,
 * unless the application installed this transport as the global itself
 * (`globalThis.fetch = defaultNodeFetch()`), where calling the global would loop
 * back here; then the one the global replaced.
 */
function platformFetch(): typeof globalThis.fetch {
  const current = globalThis.fetch
  return current === routed ? LOADED_FETCH.fetch as typeof globalThis.fetch : current
}

/** Fill `fetch` with {@link defaultNodeFetch} unless the caller chose one. */
export function withDefaultNodeFetch<Options extends { readonly fetch?: typeof globalThis.fetch }>(
  options: Options,
): Options {
  if (options.fetch !== undefined) return options
  const fetch = defaultNodeFetch()
  return fetch === undefined ? options : { ...options, fetch }
}

/**
 * Whether the global `fetch` is no longer the runtime's own: replaced since this
 * module loaded, or already replaced when it loaded (a mock or an instrumentation
 * set up first). Requests then go through it, so mocks match and spans are kept.
 */
export function globalFetchReplaced(
  current: unknown = globalThis.fetch,
  loaded: { readonly fetch: unknown; readonly builtin: boolean } = LOADED_FETCH,
): boolean {
  return current !== loaded.fetch || !loaded.builtin
}

/**
 * Whether `value` is the runtime's built-in `fetch`: Node's lazily loads undici
 * from JavaScript source; Bun's is native. A wrapper (`Proxy`, bound function,
 * `vi.fn`, an instrumentation's closure) has neither shape.
 */
export function isBuiltinFetch(value: unknown): boolean {
  if (typeof value !== 'function') return false
  let source: string
  try { source = Function.prototype.toString.call(value) }
  catch { return false }
  return (source.startsWith('function fetch(input, init') && source.includes('undici'))
    || /^function fetch\(\) \{\s*\[native code\]\s*\}$/.test(source)
}

/**
 * Agent options that change where or how a connection is made (TLS trust, socket
 * hooks, interceptors, a custom client factory). Pool limits and timeouts do not
 * change where a request goes, so they do not count.
 */
const ROUTING_OPTIONS = ['connect', 'interceptors', 'factory']

/**
 * Whether the platform `fetch` routes through a dispatcher the application chose:
 * any dispatcher that is not undici's `Agent` (a `ProxyAgent`, `EnvHttpProxyAgent`,
 * `MockAgent`, a composed dispatcher, …), or an `Agent` given routing options.
 */
export function customGlobalDispatcher(scope: object = globalThis): boolean {
  return GLOBAL_DISPATCHERS.some((key) => {
    const dispatcher = (scope as Record<symbol, unknown>)[key]
    if (typeof dispatcher !== 'object' || dispatcher === null) return false
    const name = (dispatcher as { constructor?: { name?: unknown } }).constructor?.name
    if (name === DISPATCHER_WRAPPER) return false
    return name !== 'Agent' || hasRoutingOptions(dispatcher)
  })
}

function hasRoutingOptions(agent: object): boolean {
  const key = Object.getOwnPropertySymbols(agent).find(symbol => symbol.description === 'options')
  const options = key === undefined ? undefined : (agent as Record<symbol, unknown>)[key]
  if (typeof options !== 'object' || options === null) return false
  return ROUTING_OPTIONS.some(name => (options as Record<string, unknown>)[name] != null)
}
