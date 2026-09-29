/**
 * The demo tool surface.
 *
 * An Edge isolate has no filesystem and no shell, so the tools here are the
 * ones a web-standards runtime can actually honour: the clock, and one bounded
 * HTTPS fetch. They exist to make the tool-call lane of the stream visible in
 * the UI, not to be a capable agent toolkit.
 */

import { defineTool, type ToolDefinition } from '@alvin0/ai-agent-sdk-core'

/** Largest page body the fetch tool will read, in bytes. */
const MAX_PAGE_BYTES = 400_000
/** Longest excerpt handed back to the model, in characters. */
const MAX_EXCERPT_CHARS = 6_000

interface FetchInput { readonly url: string }
interface ClockInput { readonly timeZone?: string }

/**
 * Build the tool set for one conversation.
 * @param fetchImplementation - Injected so a test can drive the fetch tool.
 * @returns Tool definitions, ready to hand to the agent.
 */
export function createEdgeTools(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): readonly ToolDefinition[] {
  const clock = defineTool<ClockInput>({
    name: 'current_time',
    description: 'Return the current date and time. The model has no clock of its own, so call this before answering anything time-relative.',
    parameters: {
      type: 'object',
      properties: { timeZone: { type: 'string', minLength: 1, maxLength: 64 } },
      required: [],
      additionalProperties: false,
    },
    parse: (value) => {
      const zone = field(value, 'timeZone')
      if (zone === undefined) return {}
      if (typeof zone !== 'string') throw new TypeError('timeZone must be a string')
      return { timeZone: zone }
    },
    execute(input) {
      const now = new Date()
      const zone = input.timeZone ?? 'UTC'
      // An unknown zone throws inside Intl; reporting it beats failing the run.
      try {
        return {
          iso: now.toISOString(),
          timeZone: zone,
          formatted: new Intl.DateTimeFormat('en-GB', {
            dateStyle: 'full', timeStyle: 'long', timeZone: zone,
          }).format(now),
        }
      } catch {
        return { iso: now.toISOString(), timeZone: 'UTC', error: `unknown time zone: ${zone}` }
      }
    },
    meta: value => ({ kind: 'clock', iso: scalar(field(value, 'iso')) }),
    isConcurrencySafe: () => true,
  })

  const read = defineTool<FetchInput>({
    name: 'fetch_url',
    description: 'Fetch one public HTTPS URL and return a bounded plain-text excerpt of it.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } },
      required: ['url'],
      additionalProperties: false,
    },
    parse: (value) => {
      const url = field(value, 'url')
      if (typeof url !== 'string') throw new TypeError('url must be a string')
      return { url }
    },
    async execute(input, context) {
      let target = publicHttpsUrl(input.url)
      let response: Response
      for (let redirects = 0;; redirects++) {
        context.signal.throwIfAborted()
        response = await fetchImplementation(target.href, {
          redirect: 'manual',
          headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
          signal: context.signal,
        })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (location === null) throw new Error('redirect destination missing')
        if (redirects >= 5) throw new Error('too many redirects')
        target = publicHttpsUrl(new URL(location, target).href)
      }
      const contentType = response.headers.get('content-type') ?? 'unknown'
      const body = await boundedText(response, context.signal)
      return {
        finalUrl: response.url === '' ? target.href : response.url,
        status: response.status,
        contentType,
        excerpt: excerpt(body, contentType),
      }
    },
    meta: value => ({
      kind: 'web-page',
      url: scalar(field(value, 'finalUrl')),
      status: scalar(field(value, 'status')),
    }),
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
  })

  return Object.freeze([clock, read])
}

/**
 * Reject anything that is not a plain public HTTPS URL.
 *
 * Loopback and private hosts are refused by name because an Edge isolate sits
 * inside the provider's network, where those addresses reach the platform's own
 * services rather than nothing at all.
 * @param value - The URL the model asked for.
 * @returns The parsed URL.
 */
function publicHttpsUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('only https URLs can be fetched')
  if (url.username.length > 0 || url.password.length > 0) throw new Error('credentials in a URL are refused')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (host.includes(':')) {
    // Only global unicast literals. Refuse mapped/translated local addresses,
    // loopback, unique-local, link-local and multicast ranges.
    const first = Number.parseInt(host.split(':')[0] ?? '', 16)
    if (!(first >= 0x2000 && first <= 0x3fff) || /^2001:(?:db8|0):|^2002:/u.test(host)) {
      throw new Error('private and loopback hosts are refused')
    }
  }
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')
    || host.endsWith('.internal') || /^(?:127|10|0|169\.254)\./u.test(host)
    || /^192\.168\./u.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)
    || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(host)
    || /^(?:22[4-9]|23\d|24\d|25[0-5])\./u.test(host) || /^198\.(?:18|19)\./u.test(host)) {
    throw new Error('private and loopback hosts are refused')
  }
  return url
}

/** Read a response body up to the byte cap, dropping the rest. */
async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let bytes = 0
  let out = ''
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    for (;;) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) { out += decoder.decode(); break }
      const accepted = chunk.value.subarray(0, MAX_PAGE_BYTES - bytes)
      bytes += accepted.byteLength
      out += decoder.decode(accepted, { stream: true })
      if (bytes >= MAX_PAGE_BYTES) break
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
  }
  return out
}

/** Strip HTML to something a model can read, then cap it. */
function excerpt(body: string, contentType: string): string {
  const text = contentType.includes('html')
    ? body
      .replaceAll(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)>/giu, ' ')
      .replaceAll(/<[^>]+>/gu, ' ')
      .replaceAll(/&(?:nbsp|amp|lt|gt|quot|#39);/gu, ' ')
    : body
  const collapsed = text.replaceAll(/\s+/gu, ' ').trim()
  return collapsed.length > MAX_EXCERPT_CHARS ? `${collapsed.slice(0, MAX_EXCERPT_CHARS)}…` : collapsed
}

function field(value: unknown, key: string): unknown {
  return value === null || typeof value !== 'object' ? undefined : Reflect.get(value, key)
}

/** Narrow an unknown tool-output field to something JSON-safe for `meta`. */
function scalar(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value
  return null
}
