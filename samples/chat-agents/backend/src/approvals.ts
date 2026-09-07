/**
 * Permission for the mutating tools, and the three scopes a human can answer in.
 *
 * The SDK already owns the mechanics: a `ToolInterceptor` returns `ask`, the
 * loop parks that one call on an `ApprovalBroker`, and the rest of the turn
 * keeps streaming. What lives here is the *policy* — which calls need asking,
 * and how long an answer lasts:
 *
 * | scope       | remembered in                        | lost when             |
 * | ----------- | ------------------------------------ | --------------------- |
 * | `once`      | nothing; the parked call consumes it | immediately           |
 * | `session`   | the live conversation                | the conversation ends |
 * | `workspace` | SQLite, keyed by workspace root      | the user revokes it   |
 *
 * A grant covers a *family* of calls, not one call: the tool name, or
 * `run_command:<executable>` so that approving `git status` does not also
 * approve `rm`.
 */

import { and, eq } from 'drizzle-orm'
import { createApprovalBroker } from '@ai-agent-sdk/core/agent'
import type {
  ApprovalDecision, InteractiveApprovalBroker, PreToolDecision, ToolInterceptor,
} from '@ai-agent-sdk/core/agent'
import type { ToolCallId } from '@ai-agent-sdk/core'
import { database, schema } from './db/client'
import { describeMutation } from './tools'
import type { WireApproval, WireApprovalScope } from './wire'

/** One standing workspace grant. */
export interface ToolPermissionRow {
  readonly id: string
  readonly workspaceRoot: string
  readonly ruleKey: string
  readonly createdAt: number
}

/**
 * The workspace-wide grants for one directory.
 * @param workspaceRoot - Absolute workspace root.
 * @returns The grants, newest last.
 */
export async function listPermissions(workspaceRoot: string): Promise<readonly ToolPermissionRow[]> {
  const { db } = database()
  return await db.select().from(schema.toolPermissions)
    .where(eq(schema.toolPermissions.workspaceRoot, workspaceRoot)).all()
}

/**
 * Remember a workspace-wide grant.
 *
 * Idempotent: the row id is derived from the root and the key, so re-granting
 * the same permission is a no-op rather than a duplicate.
 * @param workspaceRoot - Absolute workspace root.
 * @param ruleKey - The call family being permitted.
 */
export async function grantPermission(workspaceRoot: string, ruleKey: string): Promise<void> {
  const { db } = database()
  const id = `${workspaceRoot}::${ruleKey}`
  const existing = await db.select({ id: schema.toolPermissions.id })
    .from(schema.toolPermissions).where(eq(schema.toolPermissions.id, id)).all()
  if (existing.length > 0) return
  await db.insert(schema.toolPermissions).values({ id, workspaceRoot, ruleKey }).run()
}

/**
 * Withdraw a workspace-wide grant.
 * @param workspaceRoot - Absolute workspace root.
 * @param ruleKey - The call family to stop permitting.
 */
export async function revokePermission(workspaceRoot: string, ruleKey: string): Promise<void> {
  const { db } = database()
  await db.delete(schema.toolPermissions).where(and(
    eq(schema.toolPermissions.workspaceRoot, workspaceRoot),
    eq(schema.toolPermissions.ruleKey, ruleKey),
  )).run()
}

/** The parked-call gate for one conversation. */
export interface ApprovalPolicy {
  /** Hand to the SDK so it can park a call on a decision. */
  readonly broker: InteractiveApprovalBroker
  /** Hand to the SDK so mutating calls are asked about at all. */
  readonly interceptor: ToolInterceptor
  /**
   * The prompt for one parked call.
   * @param callId - The call awaiting a decision.
   * @returns Its prompt, or undefined once answered or never asked.
   */
  prompt(callId: string): WireApproval | undefined
  /** Prompts still waiting for an answer, so a page reload can re-render them. */
  pending(): readonly WireApproval[]
  /**
   * Answer one parked call.
   * @param callId - The call from the `approval` event.
   * @param decision - What the user chose.
   * @param scope - How far an `allow` reaches.
   * @returns The prompt that was answered, or undefined when the id is unknown
   *   (a legitimate outcome: the run may have been cancelled meanwhile).
   */
  decide(
    callId: string,
    decision: ApprovalDecision,
    scope: WireApprovalScope,
  ): Promise<WireApproval | undefined>
}

export interface ApprovalPolicyOptions {
  /** Directory the run's tools are confined to; the key for stored grants. */
  readonly workspaceRoot: string
  /**
   * Grants that last as long as the live conversation.
   *
   * Owned by the caller — the session store — so that a grant survives from one
   * run to the next and dies with the conversation, not with the run.
   */
  readonly sessionGrants: Set<string>
}

/**
 * Build the gate one conversation's runs share.
 * @param options - Workspace root and the conversation's session grants.
 * @returns The broker, the interceptor, and the decision entry point.
 */
export function createApprovalPolicy(options: ApprovalPolicyOptions): ApprovalPolicy {
  const { workspaceRoot, sessionGrants } = options
  const broker = createApprovalBroker()
  /** Prompt text for each parked call, so the answer can be reported richly. */
  const prompts = new Map<string, WireApproval>()

  const granted = async (ruleKey: string): Promise<boolean> => {
    if (sessionGrants.has(ruleKey)) return true
    const stored = await listPermissions(workspaceRoot)
    return stored.some(row => row.ruleKey === ruleKey)
  }

  const interceptor: ToolInterceptor = {
    name: 'chat-agents.approvals',
    before: async (call, next): Promise<PreToolDecision> => {
      const upstream = await next()
      // An earlier interceptor already refusing or already asking wins: this
      // one only adds a reason to ask, never removes one.
      if (upstream.kind !== 'allow') return upstream
      const description = await describeMutation(workspaceRoot, call.toolName, call.args)
      if (description === undefined) return upstream
      if (await granted(description.ruleKey)) return upstream
      prompts.set(call.callId, {
        callId: call.callId,
        toolName: call.toolName,
        title: description.title,
        summary: description.summary,
        ruleKey: description.ruleKey,
        ruleLabel: description.ruleLabel,
        ...description.card === undefined ? {} : { card: description.card },
      })
      // The SDK reuses this reason as the denied tool result the MODEL reads,
      // so it is phrased as a refusal rather than as a question. The card the
      // user sees comes from `prompts`, not from here.
      return {
        kind: 'ask',
        reason: `the user did not permit this call (${description.title.toLowerCase()}: ${description.summary})`,
      }
    },
  }

  return {
    broker,
    interceptor,
    prompt: callId => prompts.get(callId),
    pending: () => broker.pending()
      .map(request => prompts.get(request.callId))
      .filter((prompt): prompt is WireApproval => prompt !== undefined),
    decide: async (callId, decision, scope) => {
      const prompt = prompts.get(callId)
      // Remember the grant BEFORE releasing the call: the model may issue the
      // next call of the same family immediately, and it must not be asked again.
      if (prompt !== undefined && decision === 'allow') {
        if (scope === 'session') sessionGrants.add(prompt.ruleKey)
        if (scope === 'workspace') {
          sessionGrants.add(prompt.ruleKey)
          await grantPermission(workspaceRoot, prompt.ruleKey)
        }
      }
      const released = broker.resolve(callId as ToolCallId, decision)
      prompts.delete(callId)
      return released ? prompt : undefined
    },
  }
}
