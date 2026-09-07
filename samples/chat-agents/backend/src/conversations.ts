/**
 * Conversation persistence.
 *
 * Two things are stored per conversation: the rendered transcript (so a reload
 * shows what happened) and the agent's own `History` snapshot (so the next turn
 * continues with the same context after a server restart).
 */

import { asc, desc, eq } from 'drizzle-orm'
import { History } from '@ai-agent-sdk/core/agent'
import type { HistorySnapshot } from '@ai-agent-sdk/core/agent'
import { database, schema } from './db/client'
import type { WireEvent } from './wire'

export interface ConversationRow {
  readonly id: string
  readonly title: string
  readonly groupId: string | null
  readonly agentId: string | null
  readonly reasoningEffort: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly mode: string
  readonly workspaceRoot: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * List conversations, newest activity first.
 * @param limit - Maximum rows.
 * @returns The conversation rows without their snapshots.
 */
export async function listConversations(
  groupId?: string,
  limit = 100,
): Promise<readonly ConversationRow[]> {
  const { db } = database()
  return await db.select({
    id: schema.conversations.id,
    title: schema.conversations.title,
    groupId: schema.conversations.groupId,
    agentId: schema.conversations.agentId,
    reasoningEffort: schema.conversations.reasoningEffort,
    provider: schema.conversations.provider,
    model: schema.conversations.model,
    mode: schema.conversations.mode,
    workspaceRoot: schema.conversations.workspaceRoot,
    createdAt: schema.conversations.createdAt,
    updatedAt: schema.conversations.updatedAt,
  }).from(schema.conversations)
    .where(groupId === undefined ? undefined : eq(schema.conversations.groupId, groupId))
    .orderBy(desc(schema.conversations.updatedAt)).limit(limit).all()
}

/**
 * Fetch one conversation.
 * @param id - Conversation id.
 * @returns The row, or undefined when it does not exist yet.
 */
export async function getConversation(id: string): Promise<ConversationRow | undefined> {
  const { db } = database()
  return await db.select({
    id: schema.conversations.id,
    title: schema.conversations.title,
    groupId: schema.conversations.groupId,
    agentId: schema.conversations.agentId,
    reasoningEffort: schema.conversations.reasoningEffort,
    provider: schema.conversations.provider,
    model: schema.conversations.model,
    mode: schema.conversations.mode,
    workspaceRoot: schema.conversations.workspaceRoot,
    createdAt: schema.conversations.createdAt,
    updatedAt: schema.conversations.updatedAt,
  }).from(schema.conversations).where(eq(schema.conversations.id, id)).all().then(rows => rows[0])
}

/**
 * Create the row for a conversation the first time it is touched.
 * @param id - Conversation id.
 * @param defaults - Initial mode and workspace.
 * @returns The row.
 */
export async function ensureConversation(
  id: string,
  defaults: { mode: string; workspaceRoot: string; groupId: string },
): Promise<ConversationRow> {
  const existing = await getConversation(id)
  if (existing !== undefined) return existing
  const { db } = database()
  await db.insert(schema.conversations).values({
    id,
    title: 'New chat',
    mode: defaults.mode,
    groupId: defaults.groupId,
    workspaceRoot: defaults.workspaceRoot,
    createdAt: now(),
    updatedAt: now(),
  }).run()
  return await getConversation(id) as ConversationRow
}

/**
 * Patch a conversation's metadata.
 * @param id - Conversation id.
 * @param patch - Fields to change.
 */
export async function updateConversation(
  id: string,
  patch: Partial<Pick<
    ConversationRow,
    'title' | 'provider' | 'model' | 'mode' | 'workspaceRoot' | 'groupId' | 'agentId' | 'reasoningEffort'
  >>,
): Promise<void> {
  const { db } = database()
  await db.update(schema.conversations)
    .set({ ...patch, updatedAt: now() })
    .where(eq(schema.conversations.id, id))
    .run()
}

/**
 * Delete a conversation and its transcript.
 * @param id - Conversation id.
 */
export async function deleteConversation(id: string): Promise<void> {
  const { db } = database()
  await db.delete(schema.messages).where(eq(schema.messages.conversationId, id)).run()
  await db.delete(schema.conversations).where(eq(schema.conversations.id, id)).run()
}

/**
 * Append one rendered transcript node.
 * @param conversationId - Owning conversation.
 * @param seq - Position within the conversation.
 * @param kind - Node kind.
 * @param payload - The node itself.
 */
export async function appendMessage(
  conversationId: string,
  seq: number,
  kind: string,
  payload: unknown,
): Promise<void> {
  const { db } = database()
  await db.insert(schema.messages).values({
    id: `${conversationId}:${String(seq)}`,
    conversationId,
    seq,
    kind,
    payload: JSON.stringify(payload),
    createdAt: now(),
  }).run()
}

/**
 * Read a conversation's stored transcript.
 * @param conversationId - Owning conversation.
 * @returns The nodes in order, parsed.
 */
export async function readMessages(conversationId: string): Promise<readonly unknown[]> {
  const { db } = database()
  const rows = await db.select({ payload: schema.messages.payload })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.seq))
    .all()
  return rows.map(row => JSON.parse(row.payload) as unknown)
}

/**
 * The next free transcript position.
 * @param conversationId - Owning conversation.
 * @returns One past the highest stored `seq`.
 */
export async function nextSeq(conversationId: string): Promise<number> {
  const { db } = database()
  const rows = await db.select({ seq: schema.messages.seq })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(desc(schema.messages.seq))
    .limit(1)
    .all()
  const highest = rows[0]
  return highest === undefined ? 0 : highest.seq + 1
}

/**
 * Restore the agent history for a conversation.
 * @param id - Conversation id.
 * @returns A hydrated `History`, or a fresh one when nothing is stored.
 */
export async function loadHistory(id: string): Promise<History> {
  const { db } = database()
  const row = await db.select({ snapshot: schema.conversations.historySnapshot })
    .from(schema.conversations).where(eq(schema.conversations.id, id)).all().then(rows => rows[0])
  const raw = row?.snapshot
  if (raw === undefined || raw === null || raw.length === 0) return new History()
  try {
    return History.fromSnapshot(JSON.parse(raw) as HistorySnapshot)
  } catch {
    // A snapshot written by an older revision must not brick the conversation.
    return new History()
  }
}

/**
 * Persist the agent history for a conversation.
 * @param id - Conversation id.
 * @param history - The live history.
 */
export async function saveHistory(id: string, history: History): Promise<void> {
  const { db } = database()
  await db.update(schema.conversations)
    .set({ historySnapshot: JSON.stringify(history.snapshot()), updatedAt: now() })
    .where(eq(schema.conversations.id, id))
    .run()
}

/** Wire events the transcript keeps; deltas are folded into their node first. */
export type PersistableEvent = Extract<WireEvent, { t: 'tool-call' | 'tool-result' | 'question' }>
