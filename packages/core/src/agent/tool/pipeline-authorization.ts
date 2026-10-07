import { createApprovalRequest, type ApprovalBroker, type ApprovalRequest } from './approval.ts'
import { TOOL_ERROR_CODES, ToolError } from './errors.ts'
import type { AuthorizationOutcome, PreparedToolCall, PreToolDecision } from './pipeline.ts'
import { toolFailure } from './pipeline-support.ts'

export async function approveToolCall(
  prepared: PreparedToolCall, decision: Extract<PreToolDecision, { kind: 'ask' }>,
): Promise<Extract<AuthorizationOutcome, { kind: 'final' }> | undefined> {
  const broker = prepared.options.approvals
  if (broker === undefined) {
    return { kind: 'final', result: toolFailure(
      decision.reason ?? 'this tool requires approval, and no approver is configured',
      TOOL_ERROR_CODES.DENIED,
    ) }
  }
  const request = createApprovalRequest({
    ...prepared.options.position,
    callId: prepared.context.callId, toolName: prepared.context.toolName,
    args: prepared.context.args, turn: prepared.context.turn, step: prepared.context.step,
    ...decision.reason === undefined ? {} : { reason: decision.reason },
  })
  const answer = await awaitApproval(prepared, broker, request)
  if (answer !== 'allow' && answer !== 'deny'
    && answer !== 'abort') throw ToolError.fatal('invalid approval decision', 'INVALID_APPROVAL_DECISION')
  if (answer === 'abort') throw ToolError.fatal('the turn was withdrawn while awaiting approval',
    TOOL_ERROR_CODES.ABORTED)
  if (answer === 'deny') return { kind: 'final', result: toolFailure(
    decision.reason ?? `the call to "${prepared.context.toolName}" was not approved`,
    TOOL_ERROR_CODES.DENIED,
  ) }
  return undefined
}
async function awaitApproval(prepared: PreparedToolCall, broker: ApprovalBroker, request: ApprovalRequest) {
  // Start the broker first. The streamed approval event is backpressured, and
  // a UI is allowed to answer synchronously while handling it. Publishing
  // before request() installs its waiter loses that answer and parks forever.
  const publication = new AbortController()
  const signal = AbortSignal.any([prepared.context.signal, publication.signal])
  const pending = broker.request(request, signal)
  try {
    await prepared.options.onApprovalRequest?.(request)
  } catch (error: unknown) {
    publication.abort(error)
    await pending.catch(() => undefined)
    prepared.options.onApprovalSettled?.('error', error)
    throw error
  }
  let answer: Awaited<ReturnType<ApprovalBroker['request']>>
  try {
    answer = await pending
    prepared.options.onApprovalSettled?.(
      answer === 'abort' || prepared.context.signal.aborted ? 'aborted' : 'success',
    )
  } catch (error) {
    prepared.options.onApprovalSettled?.(prepared.context.signal.aborted ? 'aborted' : 'error', error)
    throw error
  }
  return answer
}
