/**
 * Agent presets, MCP servers, and skill roots — the three things a group can
 * configure beyond its workspace.
 *
 * MCP connections are opened lazily per run and cached per server row, because
 * a stdio server is a spawned process that must not be started per turn.
 */

import { asc, eq, isNull, or } from 'drizzle-orm'
import { connectMcpStdio } from '@ai-agent-sdk/mcp-node'
import { connectMcpHttp } from '@ai-agent-sdk/mcp/client'
import type { ToolDefinition } from '@ai-agent-sdk/core'
import { database, schema } from './db/client'

export interface AgentRow {
  readonly id: string
  readonly groupId: string | null
  readonly name: string
  readonly description: string | null
  readonly systemPrompt: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly mode: string
  readonly reasoningEffort: string | null
  /** 1 when the preset takes part in the static team roster. */
  readonly inTeam: number
  readonly createdAt: number
}

export interface McpServerRow {
  readonly id: string
  readonly groupId: string | null
  readonly name: string
  readonly transport: string
  readonly command: string | null
  readonly args: string | null
  readonly env: string | null
  readonly url: string | null
  readonly headers: string | null
  readonly enabled: number
  readonly createdAt: number
}

export interface SkillRow {
  readonly id: string
  readonly groupId: string | null
  readonly name: string
  readonly rootPath: string
  readonly enabled: number
  readonly createdAt: number
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

/** Rows scoped to one group plus the rows shared across every group. */
function scoped<T extends { groupId: unknown }>(table: T, groupId: string) {
  return or(eq(table.groupId as never, groupId), isNull(table.groupId as never))
}

// ---- agents ---------------------------------------------------------------

/**
 * List the agents visible in a group.
 * @param groupId - Owning group.
 * @returns The group's agents plus the shared ones.
 */
export async function listAgents(groupId: string): Promise<readonly AgentRow[]> {
  const { db } = database()
  return await db.select().from(schema.agents)
    .where(scoped(schema.agents, groupId))
    .orderBy(asc(schema.agents.createdAt)).all()
}

/**
 * Fetch one agent.
 * @param agentId - Agent id.
 * @returns The row, or undefined.
 */
export async function getAgent(agentId: string): Promise<AgentRow | undefined> {
  const { db } = database()
  const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).all()
  return rows[0]
}

/**
 * Create an agent preset.
 * @param input - Preset fields; `groupId` null shares it across groups.
 * @returns The new row.
 */
export async function createAgent(input: {
  groupId: string | null
  name: string
  description?: string | null
  systemPrompt?: string | null
  provider?: string | null
  model?: string | null
  mode?: string
  reasoningEffort?: string | null
  inTeam?: boolean
}): Promise<AgentRow> {
  const { db } = database()
  const row = {
    id: id('a'),
    groupId: input.groupId,
    name: input.name.trim() === '' ? 'Untitled agent' : input.name.trim(),
    description: input.description ?? null,
    systemPrompt: input.systemPrompt ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    mode: input.mode ?? 'basic',
    reasoningEffort: input.reasoningEffort ?? null,
    inTeam: input.inTeam === true ? 1 : 0,
    createdAt: now(),
  }
  await db.insert(schema.agents).values(row).run()
  return row
}

/**
 * Patch an agent preset.
 * @param agentId - Agent id.
 * @param patch - Fields to change.
 */
export async function updateAgent(agentId: string, patch: Partial<AgentRow>): Promise<void> {
  const { db } = database()
  const { id: _ignored, createdAt: _created, ...fields } = patch
  await db.update(schema.agents).set(fields).where(eq(schema.agents.id, agentId)).run()
}

/**
 * Delete an agent preset and detach conversations using it.
 * @param agentId - Agent id.
 */
export async function deleteAgent(agentId: string): Promise<void> {
  const { db } = database()
  await db.update(schema.conversations).set({ agentId: null })
    .where(eq(schema.conversations.agentId, agentId)).run()
  await db.delete(schema.agents).where(eq(schema.agents.id, agentId)).run()
}

// ---- MCP servers ----------------------------------------------------------

/**
 * List the MCP servers visible in a group.
 * @param groupId - Owning group.
 * @returns The group's servers plus the shared ones.
 */
export async function listMcpServers(groupId: string): Promise<readonly McpServerRow[]> {
  const { db } = database()
  return await db.select().from(schema.mcpServers)
    .where(scoped(schema.mcpServers, groupId))
    .orderBy(asc(schema.mcpServers.createdAt)).all()
}

/**
 * Register an MCP server.
 * @param input - Transport and its connection fields.
 * @returns The new row.
 */
export async function createMcpServer(input: {
  groupId: string | null
  name: string
  transport: 'stdio' | 'http'
  command?: string | null
  args?: readonly string[] | null
  env?: Readonly<Record<string, string>> | null
  url?: string | null
  headers?: Readonly<Record<string, string>> | null
}): Promise<McpServerRow> {
  const { db } = database()
  const row = {
    id: id('m'),
    groupId: input.groupId,
    name: input.name.trim() === '' ? 'Untitled server' : input.name.trim(),
    transport: input.transport,
    command: input.command ?? null,
    args: input.args == null ? null : JSON.stringify(input.args),
    env: input.env == null ? null : JSON.stringify(input.env),
    url: input.url ?? null,
    headers: input.headers == null ? null : JSON.stringify(input.headers),
    enabled: 1,
    createdAt: now(),
  }
  await db.insert(schema.mcpServers).values(row).run()
  return row
}

/**
 * Patch an MCP server row. Any change drops its cached connection.
 * @param serverId - Server id.
 * @param patch - Fields to change.
 */
export async function updateMcpServer(
  serverId: string,
  patch: Partial<Omit<McpServerRow, 'id' | 'createdAt'>>,
): Promise<void> {
  const { db } = database()
  await db.update(schema.mcpServers).set(patch).where(eq(schema.mcpServers.id, serverId)).run()
  await closeMcpConnection(serverId)
}

/**
 * Delete an MCP server row and close its connection.
 * @param serverId - Server id.
 */
export async function deleteMcpServer(serverId: string): Promise<void> {
  const { db } = database()
  await closeMcpConnection(serverId)
  await db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, serverId)).run()
}

interface McpHandle {
  readonly connection: {
    snapshot: (options: { signal: AbortSignal; logger?: unknown }) => { tools: readonly ToolDefinition[] }
    close: () => Promise<unknown>
  }
  readonly signature: string
}

const MCP_KEY = Symbol.for('@chat-agents/backend.mcp')

function connections(): Map<string, McpHandle> {
  const holder = globalThis as unknown as Record<symbol, Map<string, McpHandle> | undefined>
  const existing = holder[MCP_KEY]
  if (existing !== undefined) return existing
  const created = new Map<string, McpHandle>()
  holder[MCP_KEY] = created
  return created
}

/** A row's connection-relevant fields, so an edit reconnects. */
function signatureOf(row: McpServerRow): string {
  return JSON.stringify([row.transport, row.command, row.args, row.env, row.url, row.headers])
}

/**
 * Close and forget one cached MCP connection.
 * @param serverId - Server id.
 */
export async function closeMcpConnection(serverId: string): Promise<void> {
  const handle = connections().get(serverId)
  if (handle === undefined) return
  connections().delete(serverId)
  try {
    await handle.connection.close()
  } catch {
    // A server that is already gone needs no shutdown.
  }
}

/**
 * Open (or reuse) the connection for one server row.
 * @param row - The server row.
 * @returns The live connection.
 * @throws When the row is incomplete or the server refuses the handshake.
 */
async function connect(row: McpServerRow): Promise<McpHandle> {
  const signature = signatureOf(row)
  const cached = connections().get(row.id)
  if (cached !== undefined && cached.signature === signature) return cached
  if (cached !== undefined) await closeMcpConnection(row.id)

  if (row.transport === 'http') {
    if (row.url == null || row.url === '') throw new Error(`MCP server "${row.name}" has no URL`)
    const connection = await connectMcpHttp({
      serverName: row.name,
      url: row.url,
      ...row.headers == null ? {} : { headers: JSON.parse(row.headers) as Record<string, string> },
    })
    const handle = { connection, signature } as unknown as McpHandle
    connections().set(row.id, handle)
    return handle
  }

  if (row.command == null || row.command === '') throw new Error(`MCP server "${row.name}" has no command`)
  const connection = await connectMcpStdio({
    serverName: row.name,
    command: row.command,
    args: row.args == null ? [] : JSON.parse(row.args) as string[],
    ...row.env == null ? {} : { env: JSON.parse(row.env) as Record<string, string> },
  })
  const handle = { connection, signature } as unknown as McpHandle
  connections().set(row.id, handle)
  return handle
}

/** One server's live status, as the settings dialog shows it. */
export interface McpStatus {
  readonly id: string
  readonly connected: boolean
  readonly toolCount: number
  readonly error?: string
}

/**
 * Collect the tools every enabled server in a group exposes.
 * @param groupId - Owning group.
 * @returns The tools plus a per-server status line.
 */
export async function mcpTools(groupId: string): Promise<{
  tools: readonly ToolDefinition[]
  statuses: readonly McpStatus[]
}> {
  const rows = await listMcpServers(groupId)
  const tools: ToolDefinition[] = []
  const statuses: McpStatus[] = []
  for (const row of rows) {
    if (row.enabled !== 1) {
      statuses.push({ id: row.id, connected: false, toolCount: 0 })
      continue
    }
    try {
      const handle = await connect(row)
      // The snapshot contract requires a signal; a stuck server must not hang
      // the run that is only listing its tools.
      const snapshot = handle.connection.snapshot({ signal: AbortSignal.timeout(30_000) })
      tools.push(...snapshot.tools)
      statuses.push({ id: row.id, connected: true, toolCount: snapshot.tools.length })
    } catch (error) {
      statuses.push({
        id: row.id,
        connected: false,
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { tools, statuses }
}

// ---- skills ---------------------------------------------------------------

/**
 * List the skill roots visible in a group.
 * @param groupId - Owning group.
 * @returns The group's roots plus the shared ones.
 */
export async function listSkills(groupId: string): Promise<readonly SkillRow[]> {
  const { db } = database()
  return await db.select().from(schema.skills)
    .where(scoped(schema.skills, groupId))
    .orderBy(asc(schema.skills.createdAt)).all()
}

/**
 * Register a skill root.
 * @param input - Name and the directory holding SKILL.md folders.
 * @returns The new row.
 */
export async function createSkill(input: {
  groupId: string | null
  name: string
  rootPath: string
}): Promise<SkillRow> {
  const { db } = database()
  const row = {
    id: id('s'),
    groupId: input.groupId,
    name: input.name.trim() === '' ? 'Skills' : input.name.trim(),
    rootPath: input.rootPath,
    enabled: 1,
    createdAt: now(),
  }
  await db.insert(schema.skills).values(row).run()
  return row
}

/**
 * Patch a skill root.
 * @param skillId - Skill row id.
 * @param patch - Fields to change.
 */
export async function updateSkill(
  skillId: string,
  patch: Partial<Omit<SkillRow, 'id' | 'createdAt'>>,
): Promise<void> {
  const { db } = database()
  await db.update(schema.skills).set(patch).where(eq(schema.skills.id, skillId)).run()
}

/**
 * Delete a skill root.
 * @param skillId - Skill row id.
 */
export async function deleteSkill(skillId: string): Promise<void> {
  const { db } = database()
  await db.delete(schema.skills).where(eq(schema.skills.id, skillId)).run()
}
