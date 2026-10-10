import type { AgentInput } from '@alvin0/ai-agent-sdk-core'
import { startRun } from '../agent-runtime'
import type { RunHandles } from '../agent-runtime'
import { listAgents } from '../agents'
import { toolsFor } from './tools-cache'
import type { PromptProjection } from './projection'

export async function startPromptExecution(input: AgentInput, state: PromptProjection): Promise<RunHandles> {
  const { policy, wake, onMemberEvent } = state
  const { model, effort, mode, workspaceRoot, group, live, agent, controller } = state.context
  return await startRun(input, {
    registry: model.registry,
    provider: model.config.provider,
    model: model.config.model,
    effort: effort ?? undefined,
    mode,
    workspaceRoot,
    groupId: group.id,
    workspaceTools: toolsFor(workspaceRoot),
    userInput: live.broker,
    // A retry the user cannot see is indistinguishable from a hang, which is
    // the thing the retry is supposed to fix.
    onRetry: (notice) => {
      const message = `${notice.failure.message} — retrying `
        + `(${String(notice.attempt)}/${String(notice.maxAttempts)}) `
        + `in ${String(Math.round(notice.delayMs / 100) / 10)}s`
      live.outbox.push({
        wire: { t: 'notice', level: 'warn', message },
        node: { kind: 'notice', id: `n_${String(live.seq)}`, level: 'warn', message },
      })
      wake.ring()
    },
    approvals: policy.broker,
    ...live.managed === undefined ? {} : { managedTeam: live.managed },
    // One stable indirection for the harness to capture, so a worker
    // reporting during a LATER prompt is not delivered to this run.
    onWorkerEvent: (member, event) => { live.workerSink?.(member, event) },
    onLeadModelRequest: () => { live.steerUnread = false },
    interceptors: [policy.interceptor],
    agent,
    history: live.history,
    signal: controller.signal,
  }, onMemberEvent)
}

export async function bindPromptExecution(state: PromptProjection, handles: RunHandles): Promise<void> {
  const { project, wake, onMemberEvent, memberRoutes } = state
  const { live, group, model } = state.context
  if (handles.result !== undefined) project.deferOutcomeToHandle()
  // Open the steering channel only once the run exists, so a message typed
  // between prompts is a new prompt rather than a silent no-op.
  live.steerRun = handles.steer
  live.notify = () => { wake.ring() }
  if (handles.managedTeam !== undefined) live.managed = handles.managedTeam
  live.workerSink = onMemberEvent
  // Now the roster exists, so a member's tokens can be charged to its own
  // route rather than to the conversation's.
  if (handles.members.length > 0) {
    for (const row of await listAgents(group.id)) {
      if (!handles.members.includes(row.name)) continue
      memberRoutes.set(row.name, {
        provider: row.provider ?? model.config.provider,
        model: row.model ?? model.config.model,
        ...row.reasoningEffort == null ? {} : { effort: row.reasoningEffort },
      })
    }
  }

}
