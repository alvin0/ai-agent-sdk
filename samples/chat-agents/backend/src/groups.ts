/**
 * Groups (projects).
 *
 * A group owns a workspace directory and scopes the agents, MCP servers, and
 * skills available inside it. Every conversation belongs to exactly one group,
 * so switching group switches what the agent can see.
 */

import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { asc, eq, isNull } from 'drizzle-orm'
import { database, schema } from './db/client'
import { defaultWorkspace } from './workspace'

export interface GroupRow {
  readonly id: string
  readonly name: string
  readonly workspaceRoot: string
  readonly createdAt: number
  readonly updatedAt: number
}

export const DEFAULT_GROUP_ID = 'default'

function now(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * List groups, oldest first, creating the default group on first use.
 * @returns Every group.
 */
export async function listGroups(): Promise<readonly GroupRow[]> {
  const { db } = database()
  const rows = await db.select().from(schema.groups).orderBy(asc(schema.groups.createdAt)).all()
  if (rows.length > 0) return rows
  await db.insert(schema.groups).values({
    id: DEFAULT_GROUP_ID,
    name: 'Default',
    workspaceRoot: defaultWorkspace(),
    createdAt: now(),
    updatedAt: now(),
  }).run()
  // Conversations created before groups existed belong to the default group,
  // otherwise the sidebar would look empty after the upgrade.
  await db.update(schema.conversations).set({ groupId: DEFAULT_GROUP_ID })
    .where(isNull(schema.conversations.groupId)).run()
  return await db.select().from(schema.groups).orderBy(asc(schema.groups.createdAt)).all()
}

/**
 * Fetch one group, falling back to the default.
 * @param id - Group id, or undefined for the default group.
 * @returns The group row.
 */
export async function getGroup(id: string | null | undefined): Promise<GroupRow> {
  const groups = await listGroups()
  if (id != null) {
    const found = groups.find(group => group.id === id)
    if (found !== undefined) return found
  }
  return groups.find(group => group.id === DEFAULT_GROUP_ID) ?? groups[0] as GroupRow
}

/**
 * Create a group.
 * @param input - Name and the workspace directory it owns.
 * @returns The new group.
 * @throws When the workspace path is not an existing directory.
 */
export async function createGroup(input: { name?: string; workspaceRoot: string }): Promise<GroupRow> {
  const root = isAbsolute(input.workspaceRoot)
    ? resolve(input.workspaceRoot)
    : resolve(process.cwd(), input.workspaceRoot)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`)
  const { db } = database()
  const id = `g_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const named = input.name?.trim() ?? ''
  await db.insert(schema.groups).values({
    id,
    name: named === '' ? basename(root) : named,
    workspaceRoot: root,
    createdAt: now(),
    updatedAt: now(),
  }).run()
  return await getGroup(id)
}

/**
 * Rename a group or move its workspace.
 * @param id - Group id.
 * @param patch - Fields to change.
 * @returns The updated group.
 */
export async function updateGroup(
  id: string,
  patch: { name?: string; workspaceRoot?: string },
): Promise<GroupRow> {
  if (patch.workspaceRoot !== undefined) {
    const root = resolve(patch.workspaceRoot)
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`)
    patch.workspaceRoot = root
  }
  const { db } = database()
  await db.update(schema.groups).set({ ...patch, updatedAt: now() })
    .where(eq(schema.groups.id, id)).run()
  return await getGroup(id)
}

/**
 * Delete a group and detach its conversations.
 *
 * The default group is permanent: deleting it would leave conversations with
 * nowhere to live.
 * @param id - Group id.
 */
export async function deleteGroup(id: string): Promise<void> {
  if (id === DEFAULT_GROUP_ID) throw new Error('the default group cannot be deleted')
  const { db } = database()
  await db.update(schema.conversations).set({ groupId: DEFAULT_GROUP_ID })
    .where(eq(schema.conversations.groupId, id)).run()
  await db.delete(schema.agents).where(eq(schema.agents.groupId, id)).run()
  await db.delete(schema.mcpServers).where(eq(schema.mcpServers.groupId, id)).run()
  await db.delete(schema.skills).where(eq(schema.skills.groupId, id)).run()
  await db.delete(schema.groups).where(eq(schema.groups.id, id)).run()
}
