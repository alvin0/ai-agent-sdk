import type { RuntimeAgentResponse } from '@ai-agent-sdk/core/agent'
import type { SdkMcpRequestContext, SdkMcpServer } from './server-public-types.ts'

export type McpServerRuntimeFamily = 'mcp-web-server' | 'mcp-stdio-server'

export interface PreferredServerState {
  readonly agents: Readonly<Record<string, PreferredServerAgent>>
}

export interface PreferredServerAgent {
  generate(input: string, options: { readonly signal?: AbortSignal }): Promise<RuntimeAgentResponse>
}

export type InternalMcpServerFactory = (
  request: SdkMcpRequestContext,
  family: McpServerRuntimeFamily,
) => SdkMcpServer

export const MCP_WEB_SERVER_FACTORY = Symbol.for('ai-agent-sdk.mcp-web-server.factory.v1')

const STATES = new WeakMap<object, PreferredServerState>()

export function attachPreferredState(options: object, state: PreferredServerState): void {
  STATES.set(options, state)
}

export function copyPreferredState(source: object, target: object): void {
  const state = STATES.get(source)
  if (state !== undefined) STATES.set(target, state)
}

export function preferredState(options: object): PreferredServerState | undefined {
  return STATES.get(options)
}

export function internalMcpServerFactory(value: unknown): InternalMcpServerFactory | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, MCP_WEB_SERVER_FACTORY)
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'function'
    ? descriptor.value as InternalMcpServerFactory : undefined
}
