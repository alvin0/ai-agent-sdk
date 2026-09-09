import type { ContentBlock, ImageMediaType, JsonValue } from '@alvin0/ai-agent-sdk-core'
import type { SupportSafeError } from '@alvin0/ai-agent-sdk-core'
import { isJsonValue } from '@alvin0/ai-agent-sdk-core'
import type {
  McpClientStatus,
  McpCloseReport,
  McpProtocolState,
  McpToolResultValue,
  McpTransportKind,
} from './api-types.ts'
import type { McpCallToolResult } from './public-types.ts'

export class McpRemoteToolError extends Error {
  readonly result: McpCallToolResult
  constructor(serverName: string, toolName: string, result: McpCallToolResult) {
    super(`MCP tool '${serverName}/${toolName}' failed: ${resultText(result)}`)
    this.name = 'McpRemoteToolError'
    this.result = result
  }
}

export type McpConnectionStage = 'transport' | 'authentication' | 'handshake' | 'catalog' | 'unknown'

export class McpConnectionError extends Error {
  readonly code = 'MCP_CONNECT_FAILED' as const
  constructor(
    readonly stage: McpConnectionStage,
    readonly failure: SupportSafeError,
    readonly cleanup: McpCloseReport,
    cause: unknown,
  ) {
    super(`MCP connection failed during ${stage}`, { cause })
    this.name = 'McpConnectionError'
  }
}

export function connectionFailureStage(status: McpClientStatus): McpConnectionStage {
  if (status === 'authentication-failed' || status === 'authentication-required'
    || status === 'oauth-authorization-required' || status === 'scope-authorization-required') return 'authentication'
  if (status === 'connecting') return 'handshake'
  return 'unknown'
}

export function protocolState(
  client: { getNegotiatedProtocolVersion(): string | undefined; getProtocolEra(): 'modern' | 'legacy' | undefined },
  transport: McpTransportKind,
  fallback: boolean,
): McpProtocolState {
  const version = client.getNegotiatedProtocolVersion()
  return Object.freeze({
    era: client.getProtocolEra() ?? 'legacy',
    ...(version === undefined ? {} : { version }), transport, fallback,
  })
}

export function normalizeResult(result: McpCallToolResult): McpToolResultValue {
  const content = result.content.map((block, index) => {
    if (!isJsonValue(block)) throw new TypeError(`MCP result content[${index}] is not lossless JSON`)
    return block
  })
  const structured = result.structuredContent
  if (structured !== undefined && !isJsonValue(structured)) {
    throw new TypeError('MCP structuredContent is not lossless JSON')
  }
  return { content, ...(structured === undefined ? {} : { structuredContent: structured }) }
}

export function renderMcpResult(value: JsonValue | undefined): readonly ContentBlock[] {
  if (!isJsonObject(value) || !Array.isArray(value.content)) {
    return [{ type: 'text', text: value === undefined ? '(no output)' : JSON.stringify(value, null, 2) }]
  }
  const blocks = value.content.flatMap(block => renderRemoteBlock(block))
  return blocks.length === 0 ? [{ type: 'text', text: '(no output)' }] : blocks
}

function renderRemoteBlock(value: JsonValue): ContentBlock[] {
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    return [{ type: 'text', text: JSON.stringify(value) }]
  }
  if (value.type === 'text' && typeof value.text === 'string') return [{ type: 'text', text: value.text }]
  if (value.type === 'image' && typeof value.data === 'string'
    && typeof value.mimeType === 'string' && isImageMediaType(value.mimeType)) {
    return [{ type: 'image', source: { kind: 'base64', mediaType: value.mimeType, data: value.data } }]
  }
  if (value.type === 'resource' && isJsonObject(value.resource) && typeof value.resource.text === 'string') {
    return [{ type: 'text', text: value.resource.text }]
  }
  if (value.type === 'resource_link' && typeof value.uri === 'string') {
    const name = typeof value.name === 'string' ? value.name : value.uri
    return [{ type: 'text', text: `[MCP resource: ${name}](${value.uri})` }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function resultText(result: McpCallToolResult): string {
  const text = result.content
    .filter((block): block is { readonly type: 'text'; readonly text: string } => (
      typeof block === 'object' && block !== null
      && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string'
    ))
    .map(block => block.text).join('\n').trim()
  return text || 'remote tool returned an error'
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return isJsonValue(value) && typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isImageMediaType(value: string): value is ImageMediaType {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/gif' || value === 'image/webp'
}
