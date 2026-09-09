/**
 * SQLite schema. Everything the host must remember across restarts lives here:
 * conversations and their agent history, provider credentials, and app-level
 * settings such as the chosen workspace.
 *
 * The transcript the user reads is cached in the browser (IndexedDB); this
 * table set is the authority for what the AGENT sees on the next turn.
 */

import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * A group (project): a named workspace plus the agents, MCP servers, and
 * skills that belong to it. Conversations live inside one group.
 */
export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Absolute directory every tool in this group is confined to. */
  workspaceRoot: text('workspace_root').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
})

/** A configured agent: system prompt plus its default model and loop policy. */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  /** Null makes the agent available in every group. */
  groupId: text('group_id'),
  name: text('name').notNull(),
  description: text('description'),
  systemPrompt: text('system_prompt'),
  provider: text('provider'),
  model: text('model'),
  mode: text('mode').notNull().default('basic'),
  reasoningEffort: text('reasoning_effort'),
  /** 1 makes the preset a member of the static team a conversation can run. */
  inTeam: integer('in_team').notNull().default(0),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

/** An MCP server the agent may borrow tools from. */
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  groupId: text('group_id'),
  name: text('name').notNull(),
  /** 'stdio' spawns a command; 'http' connects to a streamable HTTP endpoint. */
  transport: text('transport').notNull().default('stdio'),
  command: text('command'),
  /** JSON array of command arguments. */
  args: text('args'),
  /** JSON object of environment variables for the spawned process. */
  env: text('env'),
  url: text('url'),
  /** JSON object of request headers for the HTTP transport. */
  headers: text('headers'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

/** A filesystem skill root discovered before each turn. */
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  groupId: text('group_id'),
  name: text('name').notNull(),
  /** Absolute directory holding SKILL.md folders. */
  rootPath: text('root_path').notNull(),
  enabled: integer('enabled').notNull().default(1),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  /** Owning group; null belongs to the default group. */
  groupId: text('group_id'),
  /** Agent preset driving this conversation, when one is chosen. */
  agentId: text('agent_id'),
  /** Provider-neutral reasoning effort: 'minimal' | 'low' | 'medium' | 'high'. */
  reasoningEffort: text('reasoning_effort'),
  /** Provider id chosen for this conversation, or null to follow the first ready provider. */
  provider: text('provider'),
  model: text('model'),
  /** Agent loop policy: 'basic' | 'deep' | 'deep-human-in-loop'. */
  mode: text('mode').notNull().default('basic'),
  /** Absolute directory the conversation's tools are confined to. */
  workspaceRoot: text('workspace_root'),
  /** `History.snapshot()` as JSON; restored with `History.fromSnapshot`. */
  historySnapshot: text('history_snapshot'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  /** Monotonic position inside the conversation. */
  seq: integer('seq').notNull(),
  /** Wire node kind: 'user' | 'text' | 'reasoning' | 'tool' | 'question' | 'error'. */
  kind: text('kind').notNull(),
  /** The wire node as JSON, so a reload replays exactly what was rendered. */
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, table => [index('messages_conversation_seq').on(table.conversationId, table.seq)])

export const providerCredentials = sqliteTable('provider_credentials', {
  provider: text('provider').primaryKey(),
  /** Secret at rest. Stored under the sample's git-ignored data directory. */
  apiKey: text('api_key'),
  /** Endpoint override; null uses the provider default. */
  baseUrl: text('base_url'),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
})

/**
 * A standing permission for a mutating tool, granted by the user.
 *
 * Only the "whole workspace" scope reaches this table: a one-off answer is
 * consumed by the parked call, and a session-wide answer lives with the live
 * conversation and dies with it. The key identifies a family of calls, not one
 * call — the tool name, or `run_command:<executable>` for one command.
 */
export const toolPermissions = sqliteTable('tool_permissions', {
  /** `<workspaceRoot>::<ruleKey>`, so re-granting is idempotent. */
  id: text('id').primaryKey(),
  /** Absolute directory the grant is confined to. */
  workspaceRoot: text('workspace_root').notNull(),
  ruleKey: text('rule_key').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, table => [index('tool_permissions_root').on(table.workspaceRoot)])

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

/**
 * One model call's token usage, recorded when a run reports it.
 *
 * A row per MODEL CALL rather than per run: a deep run and a team run both
 * spend tokens across several calls and several routes, and the settings page
 * has to answer "what did gpt-5.6-luna at high effort cost me", which a
 * per-run total cannot. Cached input is kept apart from fresh input because
 * the two are not billed the same.
 */
export const usageEvents = sqliteTable('usage_events', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  groupId: text('group_id'),
  runId: text('run_id').notNull(),
  /** Team member that spent this, or null for the agent the user talks to. */
  member: text('member'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  /** Reasoning effort in force for the run, when the route has one. */
  effort: text('effort'),
  /** Fresh (uncached) input tokens. */
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  reasoningTokens: integer('reasoning_tokens').notNull().default(0),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, table => [
  index('usage_events_model').on(table.provider, table.model, table.effort),
  index('usage_events_conversation').on(table.conversationId),
])

/**
 * One span of one run's execution, as the trace view reads it back.
 *
 * A row per SPAN rather than a blob per run: spans are written as they start
 * and updated when they end, so a trace opened while the run is still working
 * is the same shape as one opened afterwards. The waterfall needs nothing but
 * `startedAt`, `durationMs`, and the parent link; the details pane reads the
 * JSON columns, which are stored verbatim so a span the SDK grows a new
 * attribute for needs no migration here.
 */
export const traceSpans = sqliteTable('trace_spans', {
  /** `<runId>:<spanId>`, so re-observing a span updates one row. */
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  runId: text('run_id').notNull(),
  traceId: text('trace_id').notNull(),
  spanId: text('span_id').notNull(),
  /** Null for the root span of the run. */
  parentSpanId: text('parent_span_id'),
  /** Arrival order, so siblings that started in the same millisecond keep it. */
  seq: integer('seq').notNull(),
  /** Team member that produced this span, or null for the agent the user talks to. */
  member: text('member'),
  name: text('name').notNull(),
  /** 'invoke_agent' | 'chat' | 'execute_tool' | 'compact'. */
  kind: text('kind').notNull(),
  /** Epoch milliseconds; the waterfall measures every bar against the root. */
  startedAt: integer('started_at').notNull(),
  /** Null while the span is still open. */
  durationMs: integer('duration_ms'),
  /** 'success' | 'error' | 'aborted' | 'unknown' — unknown while open. */
  status: text('status').notNull(),
  /** OpenTelemetry GenAI attributes as JSON. */
  attributes: text('attributes'),
  /** What went in: the prompt for a run, the arguments for a tool call. */
  input: text('input'),
  output: text('output'),
  usage: text('usage'),
  error: text('error'),
  /**
   * The provider call this step made, as JSON.
   *
   * Kept apart from `input`, which is the loop's own capped summary: this is
   * the whole payload and the whole streamed answer, which is what the API tab
   * of the trace shows.
   */
  apiCall: text('api_call'),
}, table => [
  index('trace_spans_run').on(table.runId, table.seq),
  index('trace_spans_conversation').on(table.conversationId, table.startedAt),
])
