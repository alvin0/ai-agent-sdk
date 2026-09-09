export interface CodexResponseMediaFetchOptions {
  readonly baseUrl: string
  readonly officialBaseUrl: string
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Contain the official ChatGPT Codex endpoint's missing SSE media-type header.
 * Generic HTTP providers and custom Codex gateways remain strict.
 */
export function codexResponseMediaFetch(
  options: CodexResponseMediaFetchOptions,
): typeof globalThis.fetch {
  const officialEndpoint = endpoint(options.officialBaseUrl)
  const configuredEndpoint = endpoint(options.baseUrl)
  const official = configuredEndpoint !== undefined && configuredEndpoint === officialEndpoint
  return async (input, init) => {
    const implementation = options.fetch ?? globalThis.fetch
    const response = await implementation(input, init)
    // HttpModelAdapter dispatches a URL string. Keeping the compatibility path
    // string-only avoids depending on optional Request/URL globals in minimal
    // standards runtimes and refuses to broaden the exception for other inputs.
    if (typeof input !== 'string') return response
    const requestedUrl = input
    if (!official || requestedUrl !== configuredEndpoint
      || response.status !== 200 || response.body === null
      || response.headers.get('content-type') !== null
      || response.redirected || response.type === 'opaqueredirect'
      || (response.url.length > 0 && response.url !== requestedUrl)) return response
    const headers = new Headers(response.headers)
    headers.set('content-type', 'text/event-stream')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

function endpoint(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.search.length > 0 || url.hash.length > 0) return undefined
    return `${url.href.replace(/\/+$/u, '')}/responses`
  } catch {
    return undefined
  }
}
