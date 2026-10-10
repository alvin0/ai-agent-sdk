import type { UserInputResponse, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { getConversation } from '../conversations'
import { listAvailableSkills, resolveSkillMentions } from '../skill-catalog'
import { getGroup } from '../groups'
import type { WireApproval, WireApprovalScope, WireQuestion } from '../wire'
import { runOwners } from './ownership'
import { session } from './store'

/**
 * Answer a parked question.
 * @param id - Conversation id.
 * @param requestId - The provider tool-call id carried by the question event.
 * @param answers - One answer string per question id.
 * @returns Whether a waiter was actually resolved.
 */
export async function answer(
  id: string,
  requestId: string,
  answers: Readonly<Record<string, string>>,
): Promise<boolean> {
  const response: UserInputResponse = {
    answers: Object.fromEntries(
      Object.entries(answers).map(([key, value]) => [key, { answers: [value] }]),
    ),
  }
  const live = await session(id)
  return live.broker.resolve(requestId as ToolCallId, response)
}

type ApprovalAnswerArgs = [
  id: string, callId: string, decision: 'allow' | 'deny' | 'abort', scope?: WireApprovalScope, ruleKey?: string,
]

export async function approve(
  ...[id, callId, decision, scope = 'once', ruleKey]: ApprovalAnswerArgs
): Promise<boolean> {
  const live = await session(id)
  const policy = live.approvals
  if (policy === undefined) return false
  const outcome = await policy.decide(callId, decision, scope, ruleKey)
  if (outcome === undefined) return false
  // The rule reported back is the one the POLICY settled on, not the one the
  // client asked for: the record has to say what was actually remembered.
  const settled = outcome.ruleKey
  const remembered = settled === undefined ? {} : { ruleKey: settled }
  live.outbox.push({
    wire: { t: 'approval-resolved', callId, decision, scope, ...remembered },
    node: { ...outcome.prompt, kind: 'approval', id: callId, decision, scope, ...remembered },
  })
  live.notify?.()
  return true
}

/**
 * Steer the run in flight.
 *
 * The message joins the agent's history immediately, so the next model round
 * of the turn already in progress reads it — the user does not have to stop
 * the agent and start again to correct its course. It is queued for the
 * transcript the same way a permission answer is, because the run generator
 * owns the order the client sees.
 * @param id - Conversation id.
 * @param text - What the user typed while the agent was working.
 * @returns Whether a run was there to receive it.
 */
export async function steer(
  id: string,
  text: string,
  skillIds: readonly string[] = [],
): Promise<boolean> {
  const live = await session(id)
  const trimmed = text.trim()
  const steerRun = live.steerRun
  const owner = runOwners.get(live)
  if (steerRun === undefined || trimmed === '') return false
  // `/` means the same thing mid-run as it does at the start. Steering was the
  // one path where the composer offered the menu and the mention then arrived
  // as bare text the model had no reason to act on.
  const { mentioned, forModel } = await steeringMessage(id, trimmed, skillIds)
  if (live.steerRun !== steerRun || runOwners.get(live) !== owner || !steerRun(forModel)) return false
  live.steerUnread = true
  // The transcript shows what was typed; the directive was for the model.
  live.outbox.push({
    node: {
      kind: 'user',
      id: `u_${String(live.seq)}_steer`,
      text: trimmed,
      ...mentioned.skills.length === 0
        ? {}
        : { skills: mentioned.skills.map(skill => skill.id) },
    },
  })
  live.notify?.()
  return true
}

/**
 * The permission prompts this conversation is still waiting on.
 *
 * A pending prompt is never written to the transcript, so this is how a page
 * reload finds the card it has to re-render.
 * @param id - Conversation id.
 * @returns The open prompts.
 */
export async function pendingApprovals(id: string): Promise<readonly WireApproval[]> {
  const live = await session(id)
  return live.approvals?.pending() ?? []
}

/**
 * The questions this conversation is still waiting on.
 *
 * The same reason as {@link pendingApprovals}: a question is written to the
 * transcript only once it has been answered, so a reload while one is open
 * would find no card — and the run stays parked on an answer the user has no
 * way to give. A count was not enough; the card needs the questions.
 * @param id - Conversation id.
 * @returns The open questions, shaped as the client renders them.
 */
export async function pendingQuestions(id: string): Promise<readonly {
  readonly requestId: string
  readonly questions: readonly WireQuestion[]
}[]> {
  const live = await session(id)
  return live.broker.pending().map(request => ({
    requestId: String(request.requestId),
    questions: request.questions.map(question => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options.map(option => ({
        label: option.label,
        description: option.description,
      })),
    })),
  }))
}

/**
 * Cancel the session's in-flight run, if any.
 * @param id - Conversation id.
 * @returns Whether a run was cancelled.
 */
export async function abortRun(id: string): Promise<boolean> {
  const live = await session(id)
  if (live.abort === undefined) return false
  live.abort.abort(new Error('cancelled by the user'))
  live.abort = undefined
  live.broker.abortAll()
  // A parked approval holds the run open on its own promise; cancelling the
  // signal is not enough to settle it.
  live.approvals?.broker.abortAll()
  return true
}

async function steeringMessage(id: string, trimmed: string, skillIds: readonly string[]) {
  const conversation = await getConversation(id)
  const group = await getGroup(conversation?.groupId)
  const workspaceRoot = conversation?.workspaceRoot ?? group.workspaceRoot
  const mentioned = trimmed.includes('/') || skillIds.length > 0
    ? resolveSkillMentions(
      trimmed,
      await listAvailableSkills({ groupId: group.id, workspaceRoot }),
      skillIds,
    )
    : { skills: [] as const, directive: undefined }
  const forModel = mentioned.directive === undefined
    ? trimmed
    : `${mentioned.directive}\n\n${trimmed}`
  return { mentioned, forModel }
}
