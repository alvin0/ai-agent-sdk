import {
  type AgentCard,
} from '@a2a-js/sdk'
import { detachedFrozen } from '@alvin0/ai-agent-sdk-core'
import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import { fetchA2AEndpoint } from './http-redirect.ts'
import type {
  A2AAgentLinkOptions,
} from './types.ts'
import { positiveInteger, byteLength, combineSignals } from './values.ts'

export function validateAgentCard(card: AgentCard, options: A2AAgentLinkOptions): void {
  const maxBytes = positiveInteger(options.maxResponseBytes ?? 1024 * 1024, 'maxResponseBytes')
  if (byteLength(card) > maxBytes) {
    throw new RangeError(`A2A Agent Card exceeds the ${maxBytes}-byte limit`)
  }
  if (card.supportedInterfaces.length === 0) {
    throw new TypeError('A2A Agent Card must advertise at least one interface')
  }
  for (const item of card.supportedInterfaces) validateEndpoint(item.url, options)
}

export function snapshotLinkOptions(options: A2AAgentLinkOptions): A2AAgentLinkOptions {
  return Object.freeze({
    ...options,
    ...(options.allowedOrigins === undefined ? {} : {
      allowedOrigins: Object.freeze([...options.allowedOrigins]),
    }),
    ...(options.acceptedOutputModes === undefined ? {} : {
      acceptedOutputModes: Object.freeze([...options.acceptedOutputModes]),
    }),
    ...(options.serviceParameters === undefined ? {} : {
      serviceParameters: detachedFrozen(options.serviceParameters),
    }),
    ...(options.agentCard === undefined ? {} : { agentCard: detachedFrozen(options.agentCard) }),
  })
}

export function validateEndpoint(value: string, options: A2AAgentLinkOptions): URL {
  const url = new URL(value)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('A2A endpoint URL must not contain credentials')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('A2A endpoint URL must use http or https')
  }
  if (options.requireHttps === true && url.protocol !== 'https:') {
    throw new TypeError('A2A endpoint URL must use https under the configured policy')
  }
  assertEndpointPolicy(url, options)
  options.validateEndpoint?.(new URL(url))
  return url
}

export function endpointFetch(baseFetch: typeof fetch, options: A2AAgentLinkOptions): typeof fetch {
  if (typeof baseFetch !== 'function') throw new TypeError('A2A endpoint resolution requires fetch')
  const maxBytes = positiveInteger(options.maxTransportBytes ?? 16 * 1024 * 1024, 'maxTransportBytes')
  const timeoutMs = positiveInteger(options.timeoutMs ?? 120_000, 'timeoutMs')
  const teardownTimeoutMs = positiveInteger(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const value = typeof input === 'string' || input instanceof URL ? input.toString() : input.url
    validateEndpoint(value, options)
    const signal = combineSignals(init?.signal ?? undefined, AbortSignal.timeout(timeoutMs))
    const response = await fetchA2AEndpoint(baseFetch, input, init, {
      signal,
      allowRedirects: options.allowRedirects !== false,
      teardownTimeoutMs,
      validateEndpoint: value => validateEndpoint(value.toString(), options),
    })
    if (response.url.length > 0) validateEndpoint(response.url, options)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      if (response.body !== null) {
        await waitForSettlement(response.body.cancel().catch(() => undefined), teardownTimeoutMs)
      }
      throw new Error(`A2A HTTP response exceeds the ${maxBytes}-byte limit`)
    }
    if (response.body === null) return response
    let received = 0
    const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > maxBytes) {
          controller.error(new Error(`A2A HTTP response exceeds the ${maxBytes}-byte limit`))
          return
        }
        controller.enqueue(chunk)
      },
    }))
    return new Response(limited, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }) as typeof fetch
}

export function isPrivateHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (isLocalHostname(hostname)) return true
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false
  }
  return isPrivateIpv4(octets)
}

function assertEndpointPolicy(url: URL, options: A2AAgentLinkOptions): void {
  const allowedOrigins = options.allowedOrigins?.map(origin => new URL(origin).origin)
  if (allowedOrigins !== undefined && !allowedOrigins.includes(url.origin)) {
    throw new TypeError(`A2A endpoint origin '${url.origin}' is not allowed`)
  }
  if (options.allowPrivateNetwork === false && isPrivateHostname(url.hostname)) {
    throw new TypeError(`A2A endpoint host '${url.hostname}' is private or local`)
  }
}

function isLocalHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa') || !hostname.includes('.')) return true
  if (hostname.includes(':')) return true
  return false
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [first = 0, second = 0] = octets
  return first === 0 || first === 10 || first === 127 || first >= 224
    || isReservedPair(first, second)
}

function isReservedPair(first: number, second: number): boolean {
  if (first === 100) return second >= 64 && second <= 127
  if (first === 169) return second === 254
  if (first === 172) return second >= 16 && second <= 31
  if (first === 192) return second === 168
  return first === 198 && (second === 18 || second === 19)
}
