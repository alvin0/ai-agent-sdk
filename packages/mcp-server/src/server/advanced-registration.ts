import {
  McpServer,
  fromJsonSchema,
} from '@modelcontextprotocol/server'
import type { ToolCatalog } from '@alvin0/ai-agent-sdk-core/tools'
import { preferredState, type PreferredServerAgent } from '../common/preferred-state.ts'
import type {
  SdkMcpRequestContext,
} from '../common/server-public-types.ts'
import type { SdkMcpServerOptions } from './advanced-types.ts'
import { assertIdentity, serializedBytes, type ResolvedMcpServerLimits } from './advanced-support.ts'
import { callAgent, callRuntimeAgent, callSdkTool } from './advanced-calls.ts'

interface RegistrationContext {
  server: McpServer; names: Set<string>; options: SdkMcpServerOptions; request: SdkMcpRequestContext;
}

export function registerExports(ctx: RegistrationContext, limits: ResolvedMcpServerLimits): void {
  const { options } = ctx
  const schemas = options.tools?.schemas() ?? []
  const runtimeAgents = Object.entries(preferredState(options)?.agents ?? {})
  validateExports({ options, schemas, runtimeAgents, limits })
  registerTools(ctx, schemas)
  registerAgents(ctx)
  registerRuntimeAgents(ctx, runtimeAgents)
}

function registerTools(ctx: RegistrationContext, schemas: ReturnType<ToolCatalog['schemas']>): void {
  const { server, names, options } = ctx
  for (const schema of schemas) {
    if (names.has(schema.name)) throw new TypeError(`duplicate MCP export '${schema.name}'`)
    names.add(schema.name)
    server.registerTool(
      schema.name,
      {
        description: schema.description,
        // The Worker/browser validator dereferences by attaching private
        // metadata. SDK tool schemas are intentionally frozen, so give the
        // protocol boundary an isolated mutable copy.
        inputSchema: fromJsonSchema<Record<string, unknown>>(structuredClone(schema.parameters)),
      },
      async (args, context) => await callSdkTool(options, schema.name, args, context),
    )
  }
}

function registerAgents(ctx: RegistrationContext): void {
  const { server, names, options, request } = ctx
  for (const agent of options.agents ?? []) {
    assertIdentity(agent.name, 'agent MCP tool name')
    if (names.has(agent.name)) throw new TypeError(`duplicate MCP export '${agent.name}'`)
    names.add(agent.name)
    server.registerTool(
      agent.name,
      {
        description: agent.description
          ?? agent.agent.description
          ?? `Run the ${agent.agent.name} agent for one conversational turn.`,
        inputSchema: fromJsonSchema<{ input: string; conversationId?: string }>({
          type: 'object',
          properties: {
            input: { type: 'string', minLength: 1 },
            conversationId: { type: 'string', minLength: 1 },
          },
          required: ['input'],
          additionalProperties: false,
        }),
      },
      async (args, context) => await callAgent(options, { definition: agent, request }, args, context),
    )
  }
}

function registerRuntimeAgents(
  ctx: RegistrationContext, runtimeAgents: [string, PreferredServerAgent][],
): void {
  const { server, names, options } = ctx
  for (const [name, agent] of runtimeAgents) {
    assertIdentity(name, 'agent MCP tool name')
    if (names.has(name)) throw new TypeError(`duplicate MCP export '${name}'`)
    names.add(name)
    server.registerTool(name, {
      description: `Run the ${name} agent for one turn.`,
      inputSchema: fromJsonSchema<{ input: string }>({
        type: 'object', properties: { input: { type: 'string', minLength: 1 } },
        required: ['input'], additionalProperties: false,
      }),
    }, async (args, context) => await callRuntimeAgent(options, { name, agent }, args, context))
  }
}

function validateExports(input: {
  options: SdkMcpServerOptions; schemas: ReturnType<ToolCatalog['schemas']>;
  runtimeAgents: [string, PreferredServerAgent][]; limits: ResolvedMcpServerLimits;
}): void {
  const { options, schemas, runtimeAgents, limits } = input
  if (schemas.length + (options.agents?.length ?? 0) + runtimeAgents.length > limits.maxExports) {
    throw new RangeError(`MCP server exceeds the ${limits.maxExports}-export limit`)
  }
  if (serializedBytes([schemas, options.agents?.map(agent => ({
    name: agent.name, description: agent.description, agentId: agent.agent.id,
  })) ?? [], runtimeAgents.map(([name]) => ({ name }))]) > limits.maxDefinitionBytes) {
    throw new RangeError(`MCP server definitions exceed the ${limits.maxDefinitionBytes}-byte limit`)
  }
}
