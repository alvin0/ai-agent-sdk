/** Observe a bounded error prefix as the SDK consumes its original response bytes. */
const MAX_PROVIDER_ERROR_CHARS = 600
const MAX_PROVIDER_ERROR_BYTES = 4_096

export interface ProviderErrorBox {
  message: string | undefined
  owner?: symbol
  status?: number
  requestId?: string
  ambiguous?: boolean
}

export function resetProviderError(box: ProviderErrorBox): void {
  box.owner = Symbol()
  box.message = undefined
  delete box.status
  delete box.requestId
  delete box.ambiguous
}

/** Match the captured response to the terminal failure before presenting its words. */
export function providerErrorDetail(box: ProviderErrorBox, call: {
  readonly error?: { readonly status?: number }
  readonly attempts: readonly { readonly providerRequestId?: string }[]
} | undefined): string | undefined {
  if (call === undefined || box.status !== call.error?.status) return undefined
  const requestId = call.attempts.at(-1)?.providerRequestId
  if (box.requestId !== undefined || requestId !== undefined) {
    return box.requestId === requestId ? box.message : undefined
  }
  return box.ambiguous === true ? undefined : box.message
}

export function capturingFetch(box: ProviderErrorBox, apiKey?: string): typeof globalThis.fetch {
  let active = 0
  return async (input, init) => {
    const owner = Symbol()
    box.owner = owner
    box.message = undefined
    delete box.status
    delete box.requestId
    if (++active > 1) box.ambiguous = true
    let response: Response
    try { response = await fetch(input, init) }
    catch (error) { active--; throw error }
    recordResponse(box, owner, response)
    if (response.ok || response.body === null || response.status < 200) { active--; return response }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let remaining = MAX_PROVIDER_ERROR_BYTES
    let prefix = ''
    let finished = false
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      active--
    }
    const finish = (complete: boolean): void => {
      if (finished) return
      finished = true
      if (box.owner === owner) {
        box.message = complete ? providerMessage(prefix + decoder.decode(), apiKey) : undefined
      }
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read()
          if (item.done) { finish(true); release(); reader.releaseLock(); controller.close(); return }
          if (remaining > 0) {
            const count = Math.min(remaining, item.value.byteLength)
            prefix += decoder.decode(item.value.subarray(0, count), { stream: true })
            remaining -= count
            if (remaining === 0) finish(false)
          }
          controller.enqueue(item.value)
        } catch (error) { finish(false); release(); reader.releaseLock(); controller.error(error) }
      },
      async cancel(reason) {
        finish(false)
        try { await reader.cancel(reason) } finally { release(); reader.releaseLock() }
      },
    }, { highWaterMark: 0 })
    const observed = new Response(body, response)
    Object.defineProperties(observed, {
      url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
    })
    return observed
  }
}

function recordResponse(box: ProviderErrorBox, owner: symbol, response: Response): void {
  if (box.owner !== owner) return
  box.status = response.status
  const requestId = ['request-id', 'x-request-id', 'x-requestid', 'cf-ray']
    .map(name => response.headers.get(name)).find(value => value !== null && value.length > 0)
  if (requestId !== undefined && requestId !== null) box.requestId = requestId
}

function providerMessage(raw: string, apiKey: string | undefined): string | undefined {
  const text = raw.trim()
  if (text.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    const message = objectField(objectField(parsed, 'error'), 'message')
    return typeof message === 'string' && message.trim().length > 0
      ? redactProviderCredentials(message, apiKey).slice(0, MAX_PROVIDER_ERROR_CHARS) : undefined
  } catch {
    // A partial JSON object may contain credential fields outside error.message.
    if (text.startsWith('{') || text.startsWith('[')) return undefined
  }
  return redactProviderCredentials(text, apiKey).slice(0, MAX_PROVIDER_ERROR_CHARS)
}

function objectField(value: unknown, key: string): unknown {
  return value === null || typeof value !== 'object' ? undefined : Reflect.get(value, key)
}

export function redactProviderCredentials(message: string, apiKey: string | undefined): string {
  const safe = apiKey === undefined || apiKey.length === 0
    ? message : redactClippedCredential(message.replaceAll(apiKey, '[REDACTED]'), apiKey)
  return safe.replace(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-z0-9_-]+/giu, '[REDACTED]')
}

/** SDK trace previews end at an ellipsis, possibly in the middle of an opaque key. */
function redactClippedCredential(message: string, apiKey: string): string {
  if (!message.includes('…')) return message
  const fallback = credentialPrefixFallback(apiKey)
  const pieces: string[] = []
  let copied = 0
  let matched = 0
  for (let index = 0; index < message.length; index++) {
    if (message[index] === '…' && matched > 0) {
      pieces.push(message.slice(copied, index - matched), '[REDACTED]')
      copied = index
      matched = 0
    }
    while (matched > 0 && message[index] !== apiKey[matched]) matched = fallback[matched - 1]!
    if (message[index] === apiKey[matched]) matched++
    if (matched === apiKey.length) matched = fallback[matched - 1]!
  }
  pieces.push(message.slice(copied))
  return pieces.join('')
}

function credentialPrefixFallback(apiKey: string): number[] {
  const fallback = new Array<number>(apiKey.length).fill(0)
  let matched = 0
  for (let index = 1; index < apiKey.length; index++) {
    while (matched > 0 && apiKey[index] !== apiKey[matched]) matched = fallback[matched - 1]!
    if (apiKey[index] === apiKey[matched]) matched++
    fallback[index] = matched
  }
  return fallback
}
