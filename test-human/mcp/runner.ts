import { InMemoryTransport } from '@modelcontextprotocol/client'
import { defineTool, dispatchToolCall, ToolRegistry } from '@ai-agent-sdk/core/agent'
import { ToolCallId } from '@ai-agent-sdk/core'
import { McpClientConnection, type McpClientState } from '@ai-agent-sdk/mcp/client'
import { createSdkMcpServer } from '@ai-agent-sdk/mcp/server'

export interface McpRoundTripOptions {
  readonly requests: number
  readonly parallel: number
  readonly cycles: number
  readonly signal?: AbortSignal
  readonly onCycle?: (result: McpCycleResult) => void
}

export interface McpCycleResult {
  readonly cycle: number
  readonly requests: number
  readonly passed: number
  readonly expectedErrors: number
  readonly unexpected: readonly string[]
  readonly lifecycle: readonly string[]
  readonly discoveredTools: readonly string[]
  readonly protocolVersion?: string
}

export interface McpRoundTripResult {
  readonly cycles: readonly McpCycleResult[]
  readonly requests: number
  readonly passed: number
  readonly expectedErrors: number
  readonly unexpected: readonly string[]
}

const inventory = new Map([
  ['mechanical-keyboard', { stock: 14, unitPrice: 89 }],
  ['usb-c-dock', { stock: 7, unitPrice: 129 }],
])

export async function runMcpRoundTrips(options: McpRoundTripOptions): Promise<McpRoundTripResult> {
  assertPositive(options.requests, 'requests')
  assertPositive(options.parallel, 'parallel')
  assertPositive(options.cycles, 'cycles')
  const signal = options.signal ?? new AbortController().signal
  const cycles: McpCycleResult[] = []
  for (let cycle = 0; cycle < options.cycles; cycle++) {
    signal.throwIfAborted()
    const result = await runCycle(cycle, options.requests, options.parallel, signal)
    cycles.push(result)
    options.onCycle?.(result)
  }
  return Object.freeze({
    cycles: Object.freeze(cycles),
    requests: cycles.reduce((total, item) => total + item.requests, 0),
    passed: cycles.reduce((total, item) => total + item.passed, 0),
    expectedErrors: cycles.reduce((total, item) => total + item.expectedErrors, 0),
    unexpected: Object.freeze(cycles.flatMap(item => item.unexpected)),
  })
}

async function runCycle(
  cycle: number,
  requests: number,
  parallel: number,
  signal: AbortSignal,
): Promise<McpCycleResult> {
  const states: McpClientState[] = []
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createSdkMcpServer({
    name: 'warehouse-api', version: '1.0.0',
    instructions: 'Inventory quoting API exported from ai-agent-sdk.', tools: createInventoryTools(),
  })
  await server.connect(serverTransport)
  const client = new McpClientConnection({
    serverName: 'warehouse', reconnect: false,
    onStateChange: state => { states.push(state) },
  }, () => clientTransport)
  let passed = 0
  let expectedErrors = 0
  let discoveredTools: readonly string[] = Object.freeze([])
  let protocolVersion: string | undefined
  const unexpected: string[] = []
  try {
    signal.throwIfAborted()
    await client.connect()
    discoveredTools = client.tools.names()
    protocolVersion = client.state.protocol?.version
    if (!discoveredTools.includes('mcp__warehouse__quote_inventory')) {
      unexpected.push(`cycle ${cycle}: namespaced tool was not discovered`)
    }
    let cursor = 0
    const workers = Array.from({ length: Math.min(parallel, requests) }, async () => {
      while (true) {
        const index = cursor++
        if (index >= requests) return
        signal.throwIfAborted()
        const test = requestCase(index)
        const result = await dispatchToolCall({
          catalog: client.tools,
          call: {
            callId: ToolCallId(`human-mcp-${cycle}-${index}`),
            toolName: 'mcp__warehouse__quote_inventory',
            rawArguments: JSON.stringify(test.arguments),
          },
          position: { turn: cycle + 1, step: index + 1 }, signal,
        })
        if (result.isError === test.expectError) {
          passed++
          if (test.expectError) expectedErrors++
          if (!test.expectError && !result.isError) {
            const structured = Reflect.get(result.value as object, 'structuredContent')
            const total = structured === null || typeof structured !== 'object'
              ? undefined : Reflect.get(structured, 'totalUsd')
            if (total !== test.expectedTotal) {
              unexpected.push(`cycle ${cycle} request ${index}: total=${String(total)} expected=${test.expectedTotal}`)
            }
          }
        } else {
          unexpected.push(`cycle ${cycle} request ${index}: isError=${result.isError} expected=${test.expectError}`)
        }
        if (result.meta?.kind !== 'mcp' || result.meta.serverName !== 'warehouse') {
          unexpected.push(`cycle ${cycle} request ${index}: MCP provenance metadata missing`)
        }
      }
    })
    await Promise.all(workers)
  } finally {
    await Promise.allSettled([client.close(), server.close()])
  }
  return Object.freeze({
    cycle, requests, passed, expectedErrors, unexpected: Object.freeze(unexpected),
    lifecycle: Object.freeze(lifecycleTransitions(states)),
    discoveredTools,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
  })
}

function lifecycleTransitions(states: readonly McpClientState[]): readonly string[] {
  const transitions: string[] = []
  for (const state of states) {
    if (transitions.at(-1) !== state.status) transitions.push(state.status)
  }
  return transitions
}

function createInventoryTools(): ToolRegistry {
  const api = new ToolRegistry()
  api.register(defineTool({
    name: 'quote_inventory',
    description: 'Quote current stock and total price for an inventory item.',
    parameters: {
      type: 'object',
      properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
      required: ['sku', 'quantity'], additionalProperties: false,
    },
    parse: raw => raw as { sku: string; quantity: number },
    execute: ({ sku, quantity }) => {
      const item = inventory.get(sku)
      if (item === undefined) throw new Error(`unknown sku '${sku}'`)
      if (quantity > item.stock) throw new Error(`only ${item.stock} units are available`)
      return { sku, quantity, available: item.stock, totalUsd: quantity * item.unitPrice }
    },
  }))
  return api
}

function requestCase(index: number): {
  readonly arguments: { readonly sku: string; readonly quantity: number }
  readonly expectError: boolean
  readonly expectedTotal?: number
} {
  if (index % 4 === 0) {
    const quantity = 1 + (index % 7)
    return { arguments: { sku: 'usb-c-dock', quantity }, expectError: false, expectedTotal: quantity * 129 }
  }
  if (index % 4 === 1) {
    const quantity = 1 + (index % 14)
    return { arguments: { sku: 'mechanical-keyboard', quantity }, expectError: false, expectedTotal: quantity * 89 }
  }
  if (index % 4 === 2) return { arguments: { sku: 'unknown-sku', quantity: 1 }, expectError: true }
  return { arguments: { sku: 'usb-c-dock', quantity: 8 }, expectError: true }
}

function assertPositive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive integer`)
}
