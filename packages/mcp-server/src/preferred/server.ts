import type { RuntimeAgent, RuntimeAgentInvocationOptions, RuntimeAgentResponse } from '@ai-agent-sdk/core/agent'
import type { SdkLogger, ToolCatalog } from '@ai-agent-sdk/core/tools'
import { createSdkMcpHandler, createSdkMcpServer, type SdkMcpServerOptions } from '../server/advanced.ts'
import {
  attachPreferredState, copyPreferredState, MCP_WEB_SERVER_FACTORY,
  type InternalMcpServerFactory, type PreferredServerAgent,
} from '../common/preferred-state.ts'
import { MCP_SERVER_DEFAULTS } from '../common/config.ts'

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
    const forwarded = signal === request.signal ? request : new Request(request, { signal })
    if (!await requestFits(forwarded, maxRequestBytes)) return payloadTooLarge()
    const handlerOptions: SdkMcpServerOptions = { ...advanced, integrationFamily: 'mcp-web-server' }
    copyPreferredState(advanced, handlerOptions)
    const handler = createSdkMcpHandler(handlerOptions)
    try {
      const response = await handler.fetch(forwarded)
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

async function requestFits(request: Request, limit: number): Promise<boolean> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) return false
  }
  if (request.body === null) return true
  try { return (await request.clone().arrayBuffer()).byteLength <= limit } catch { return false }
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid MCP server definition')
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
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') throw new TypeError(`${label} is invalid`)
  return value as T
}
