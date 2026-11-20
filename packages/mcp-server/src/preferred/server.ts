import type { RuntimeAgent, RuntimeAgentInvocationOptions, RuntimeAgentResponse } from '@alvin0/ai-agent-sdk-core/agent'
import type { SdkLogger, ToolCatalog } from '@alvin0/ai-agent-sdk-core/tools'
import { createSdkMcpHandler, createSdkMcpServer, type SdkMcpServerOptions } from '../server/advanced.ts'
import {
  attachPreferredState, copyPreferredState, MCP_WEB_SERVER_FACTORY,
  type InternalMcpServerFactory, type PreferredServerAgent,
} from '../common/preferred-state.ts'
import { MCP_SERVER_DEFAULTS } from '../common/config.ts'

const typedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag,
)!.get!

export interface McpServerDefinition {
  readonly id: string
  readonly logger?: SdkLogger
  readonly tools?: ToolCatalog
  readonly agents?: Readonly<Record<string, RuntimeAgent>>
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
}

export interface McpWebServer {
  handle(request: Request, options?: { readonly signal?: AbortSignal }): Promise<Response>
}

/** Capture one inert Web-standard server definition; each handle call owns its request resources. */
export function createMcpServer(definition: McpServerDefinition): McpWebServer {
  const source = objectValue(definition)
  const id = identity(ownValue(source, 'id'), 'MCP server id')
  const logger = optionalObject<SdkLogger>(ownValue(source, 'logger', false), 'MCP server logger')
  const tools = captureToolCatalog(ownValue(source, 'tools', false))
  const agents = captureAgents(ownValue(source, 'agents', false))
  const maxRequestBytes = positive(
    ownValue(source, 'maxRequestBytes', false) ?? MCP_SERVER_DEFAULTS.maxInputBytes, 'maxRequestBytes',
  )
  const maxResponseBytes = positive(
    ownValue(source, 'maxResponseBytes', false) ?? MCP_SERVER_DEFAULTS.maxOutputBytes, 'maxResponseBytes',
  )
  const advanced: SdkMcpServerOptions = Object.freeze({
    name: id, version: '1.0.0',
    ...(logger === undefined ? {} : { logger }),
    ...(tools === undefined ? {} : { tools }),
    maxInputBytes: maxRequestBytes, maxOutputBytes: maxResponseBytes,
  })
  attachPreferredState(advanced, Object.freeze({ agents }))

  const factory: InternalMcpServerFactory = (request, family) => {
    const scoped: SdkMcpServerOptions = { ...advanced, integrationFamily: family }
    copyPreferredState(advanced, scoped)
    return createSdkMcpServer(scoped, request)
  }
  const handle = async (request: Request, options?: { readonly signal?: AbortSignal }): Promise<Response> => {
    if (!(request instanceof Request)) throw new TypeError('MCP Web server requires a Request')
    const signal = options?.signal === undefined ? request.signal
      : AbortSignal.any([request.signal, options.signal])
    signal.throwIfAborted()
    const bounded = await boundedRequest(request, maxRequestBytes, signal)
    if (bounded === undefined) return payloadTooLarge()
    const handlerOptions: SdkMcpServerOptions = { ...advanced, integrationFamily: 'mcp-web-server' }
    copyPreferredState(advanced, handlerOptions)
    const handler = createSdkMcpHandler(handlerOptions)
    try {
      const response = await handler.fetch(bounded)
      return boundedResponse(response, maxResponseBytes, handler.close)
    } catch (error: unknown) {
      await settleClose(handler.close)
      throw error
    }
  }
  const result = { handle }
  Object.defineProperty(result, MCP_WEB_SERVER_FACTORY, { value: factory, enumerable: false })
  return Object.freeze(result)
}

function captureAgents(value: unknown): Readonly<Record<string, PreferredServerAgent>> {
  if (value === undefined) return Object.freeze({})
  const source = objectValue(value), entries: [string, PreferredServerAgent][] = []
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string') throw new TypeError('MCP agent names must be strings')
    identity(key, 'MCP agent name')
    const agent = objectValue(ownValue(source, key)) as RuntimeAgent
    const generate = method(agent, 'generate')
    entries.push([key, Object.freeze({
      generate: (input: string, options: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse> =>
        Reflect.apply(generate, agent, [input, options]) as Promise<RuntimeAgentResponse>,
    })])
  }
  return Object.freeze(Object.fromEntries(entries))
}

function captureToolCatalog(value: unknown): ToolCatalog | undefined {
  if (value === undefined) return undefined
  const catalog = objectValue(value) as ToolCatalog
  const get = method(catalog, 'get'), has = method(catalog, 'has'), names = method(catalog, 'names')
  const schemas = method(catalog, 'schemas'), executionMode = method(catalog, 'executionMode')
  return Object.freeze({
    get: (name: string) => Reflect.apply(get, catalog, [name]) as ReturnType<ToolCatalog['get']>,
    has: (name: string) => Reflect.apply(has, catalog, [name]) as boolean,
    names: () => Reflect.apply(names, catalog, []) as readonly string[],
    schemas: () => Reflect.apply(schemas, catalog, []) as ReturnType<ToolCatalog['schemas']>,
    executionMode(name: string, args: unknown): 'parallel' | 'exclusive' {
      return Reflect.apply(executionMode, catalog, [name, args]) as 'parallel' | 'exclusive'
    },
  })
}

async function boundedRequest(request: Request, limit: number, signal: AbortSignal): Promise<Request | undefined> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) {
      void request.body?.cancel().catch(() => undefined)
      return undefined
    }
  }
  if (request.body === null) return new Request(request, { signal })
  if (request.bodyUsed || request.body.locked) return undefined
  const body = await boundedRequestBody(request.body, signal, limit)
  return body === undefined ? undefined : new Request(request, { body, signal })
}

async function boundedRequestBody(
  source: ReadableStream<Uint8Array>, signal: AbortSignal, limit: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = source.getReader()
  let body = new Uint8Array(0)
  let bytes = 0, complete = false
  const abort = (): void => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const next = await reader.read()
      signal.throwIfAborted()
      if (next.done) { complete = true; break }
      if (!isByteChunk(next.value)) return undefined
      const required = bytes + next.value.byteLength
      if (required > limit) return undefined
      if (required > body.byteLength) {
        const expanded = new Uint8Array(Math.min(limit, Math.max(required, body.byteLength * 2, 1024)))
        expanded.set(body)
        body = expanded
      }
      body.set(next.value, bytes)
      bytes = required
    }
  } catch {
    signal.throwIfAborted()
    return undefined
  } finally {
    signal.removeEventListener('abort', abort)
    if (!complete) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return body.subarray(0, bytes)
}

function isByteChunk(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && typedArrayTag.call(value) === 'Uint8Array'
}

function boundedResponse(response: Response, limit: number, close: () => Promise<void>): Response {
  if (response.body === null) { void settleClose(close); return response }
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > limit) {
    void response.body.cancel(); void settleClose(close)
    return responseTooLarge()
  }
  const reader = response.body.getReader()
  let bytes = 0, closed = false
  const finish = async (): Promise<void> => {
    if (closed) return
    closed = true
    await settleClose(close)
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) { controller.close(); await finish(); return }
        bytes += next.value.byteLength
        if (bytes > limit) {
          await reader.cancel(); await finish()
          controller.error(new RangeError('MCP response exceeded maxResponseBytes'))
          return
        }
        controller.enqueue(next.value)
      } catch (error: unknown) { await finish(); controller.error(error) }
    },
    async cancel(reason) { try { await reader.cancel(reason) } finally { await finish() } },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

function payloadTooLarge(): Response {
  return Response.json({ jsonrpc: '2.0', id: null,
    error: { code: -32600, message: 'MCP request exceeds maxRequestBytes' } }, { status: 413 })
}
function responseTooLarge(): Response {
  return Response.json({ jsonrpc: '2.0', id: null,
    error: { code: -32603, message: 'MCP response exceeds maxResponseBytes' } }, { status: 500 })
}
async function settleClose(close: () => Promise<void>): Promise<void> { try { await close() } catch {} }
function objectValue(value: unknown): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid MCP server definition')
  }
  return value
}
function ownValue(source: object, key: PropertyKey, required = true): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor === undefined) {
    if (!required) return undefined
    throw new TypeError(`Missing MCP server field ${String(key)}`)
  }
  if (!('value' in descriptor)) throw new TypeError(`MCP server field ${String(key)} must be data`)
  return descriptor.value
}
function method(source: object, key: PropertyKey): Function {
  const value = Reflect.get(source, key)
  if (typeof value !== 'function') throw new TypeError(`MCP server method ${String(key)} is invalid`)
  return value
}
function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new TypeError(`${label} is invalid`)
  return value
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`MCP server ${label} is invalid`)
  return Number(value)
}
function optionalObject<T>(value: unknown, label: string): T | undefined {
  if (value === undefined) return undefined
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    throw new TypeError(`${label} is invalid`)
  }
  return value as T
}
