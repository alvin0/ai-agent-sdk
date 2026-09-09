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
 * A grant covers a *family* of calls, not one call, and the prompt offers the
 * user the family's WIDTH as a second axis next to the scope's duration:
 *
 * | rule key                        | covers                                |
 * | ------------------------------- | ------------------------------------- |
 * | `run_command:prefix:git diff`   | every `git diff …` command            |
 * | `run_command:prefix:git`        | every `git` command                   |
 * | `run_command:<executable>`      | the same, as written before prefixes  |
 * | `write_file:dir:src/ui`         | writes under `src/ui/`                |
 * | `write_file`                    | writes anywhere in the workspace      |
 *
 * Matching stays an equality check on purpose: `describeMutation` enumerates
 * every key that would cover the pending call (`matchKeys`), so a prefix rule
 * is honoured without this module re-parsing the command line — one derivation,
 * used both to offer a rule and to recognise a stored one.
 */

import { and, eq } from 'drizzle-orm'
import { createApprovalBroker } from '@ai-agent-sdk/core/agent'
import type {
  ApprovalDecision, InteractiveApprovalBroker, PreToolDecision, ToolInterceptor,
} from '@ai-agent-sdk/core/agent'
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
   * @param scope - How long an `allow` lasts.
   * @param ruleKey - Which of the prompt's rules the grant is stored under;
   *   defaults to the narrowest rule offered. A key the prompt did not offer is
   *   ignored rather than trusted — the client does not get to widen a grant.
   * @returns What was answered — the prompt plus the rule the grant landed on —
   *   or undefined when the id is unknown (a legitimate outcome: the run may
   *   have been cancelled meanwhile).
   */
  decide(
    callId: string,
    decision: ApprovalDecision,
    scope: WireApprovalScope,
    ruleKey?: string,
  ): Promise<ApprovalOutcome | undefined>
}

/**
 * The prompt for a call this policy did not describe.
 *
 * Only reachable when another interceptor asked: its `reason` is written for
 * the model, so there is nothing to quote on a card, and nothing to remember.
 * @param callId - The call that was answered.
 * @returns A prompt saying only which call it was.
 */
function unnamed(callId: string, toolName: string): WireApproval {
  return {
    callId,
    toolName,
    title: toolName,
    summary: 'This call needs your permission.',
    rules: [],
  }
}

/** What one answered prompt turned into. */
export interface ApprovalOutcome {
  /** The prompt as it was shown. */
  readonly prompt: WireApproval
  /** The rule the grant was stored under; absent when nothing was remembered. */
  readonly ruleKey?: string
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
  const prepared = new Map<string, WireApproval>()
  const key = (call: { runId?: string; conversationId?: string; callId: string; turn: number; step: number }) =>
    JSON.stringify([call.runId, call.conversationId, call.turn, call.step, call.callId])
  const deciding = new Set<string>()

  const granted = async (matchKeys: readonly string[]): Promise<boolean> => {
    if (matchKeys.length === 0) return false
    if (matchKeys.some(key => sessionGrants.has(key))) return true
    const stored = await listPermissions(workspaceRoot)
    return stored.some(row => matchKeys.includes(row.ruleKey))
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
      if (await granted(description.matchKeys)) return upstream
      prepared.set(key(call), {
        callId: call.callId,
        toolName: call.toolName,
        title: description.title,
        summary: description.summary,
        rules: description.rules,
        ...description.hazards.length === 0 ? {} : { hazards: description.hazards },
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

  broker.onRequest(request => {
    const prompt = prepared.get(key(request))
    prepared.delete(key(request))
    if (prompt !== undefined) prompts.set(request.approvalRequestId, { ...prompt, callId: request.approvalRequestId, providerCallId: request.providerCallId })
  })

  return {
    broker,
    interceptor,
    prompt: callId => prompts.get(callId),
    pending: () => broker.pending()
      .map(request => prompts.get(request.approvalRequestId))
      .filter((prompt): prompt is WireApproval => prompt !== undefined),
    decide: async (callId, decision, scope, ruleKey) => {
      if (deciding.has(callId)) return undefined
      deciding.add(callId)
      try {
        const parked = broker.pending().find(request => request.approvalRequestId === callId)
        if (parked === undefined) return undefined
        const prompt = prompts.get(callId)
        if (prompt === undefined) {
          // Parked by an interceptor other than this one, so there is no rule
          // this policy could store. Release it anyway: a call this policy
          // cannot describe is still a call the user just answered, and
          // refusing to settle it would leave the run waiting forever.
          const released = broker.resolve(callId, decision)
          return released ? { prompt: unnamed(callId, parked.toolName) } : undefined
        }
        // The chosen rule must be one this prompt offered. A prompt that
        // offered none (an opaque command line, an executable never granted
        // wholesale) cannot be remembered at all, whatever scope was asked for.
        const chosen = prompt.rules.find(rule => rule.key === ruleKey)?.key ?? prompt.rules[0]?.key
        const remembered = decision === 'allow' && scope !== 'once' ? chosen : undefined
        // Remember the grant BEFORE releasing the call: the model may issue the
        // next call of the same family immediately, and it must not be asked again.
        if (remembered !== undefined) {
          sessionGrants.add(remembered)
          if (scope === 'workspace') await grantPermission(workspaceRoot, remembered)
        }
        const released = broker.resolve(callId, decision)
        prompts.delete(callId)
        return released
          ? { prompt, ...remembered === undefined ? {} : { ruleKey: remembered } }
          : undefined
      } finally { deciding.delete(callId) }
    },
  }
}
