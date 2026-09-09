import { A2A_PROTOCOL_VERSION, type AgentCard, type AgentProvider,
  type AgentSkill, type SecurityRequirement, type SecurityScheme } from '@a2a-js/sdk'
import type { DefinedAgent } from '@alvin0/ai-agent-sdk-core/agent'

export interface AgentCardFromDefinitionOptions {
  readonly url: string
  readonly protocolBinding?: 'JSONRPC' | 'HTTP+JSON' | 'GRPC' | (string & {})
  readonly version?: string
  readonly provider?: AgentProvider
  readonly documentationUrl?: string
  readonly iconUrl?: string
  readonly tags?: readonly string[]
  readonly examples?: readonly string[]
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>>
  readonly securityRequirements?: readonly SecurityRequirement[]
  readonly requireHttps?: boolean
}

export function createAgentCardFromDefinition(
  agent: DefinedAgent,
  options: AgentCardFromDefinitionOptions,
): AgentCard {
  const url = endpointUrl(options.url, options.requireHttps === true)
  const securitySchemes = structuredClone(options.securitySchemes ?? {})
  const securityRequirements: SecurityRequirement[] = structuredClone([
    ...options.securityRequirements ?? [],
  ])
  assertSecurityRequirements(securitySchemes, securityRequirements)
  const description = agent.description ?? `${agent.name} powered by ai-agent-sdk`
  const skill: AgentSkill = {
    id: agent.id, name: agent.name, description,
    tags: [...options.tags ?? [agent.id]], examples: [...options.examples ?? []],
    inputModes: ['text/plain', 'image/*', 'application/json'], outputModes: ['text/plain'],
    securityRequirements: structuredClone(securityRequirements),
  }
  return {
    name: agent.name, description,
    supportedInterfaces: [{ url: url.href, protocolBinding: options.protocolBinding ?? 'JSONRPC',
      tenant: '', protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: options.provider, version: options.version ?? '1.0.0',
    ...(options.documentationUrl === undefined ? {} : { documentationUrl: options.documentationUrl }),
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes, securityRequirements,
    defaultInputModes: ['text/plain', 'image/*', 'application/json'], defaultOutputModes: ['text/plain'],
    skills: [skill], signatures: [],
    ...(options.iconUrl === undefined ? {} : { iconUrl: options.iconUrl }),
  }
}

export function assertSecurityRequirements(
  schemes: Record<string, SecurityScheme>,
  requirements: readonly SecurityRequirement[],
): void {
  for (const requirement of requirements) {
    for (const name of Object.keys(requirement.schemes)) {
      if (schemes[name] === undefined) {
        throw new TypeError(`A2A security requirement references unknown scheme '${name}'`)
      }
      if (schemes[name]?.scheme === undefined) {
        throw new TypeError(`A2A security scheme '${name}' has no concrete definition`)
      }
    }
  }
}

function endpointUrl(value: string, requireHttps: boolean): URL {
  const url = new URL(value)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('A2A interface URL must not contain credentials')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('A2A interface URL must use http or https')
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new TypeError('A2A interface URL must use https under the configured policy')
  }
  return url
}
