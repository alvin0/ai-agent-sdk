import type { AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'
import type { RunHandles } from '../agent-runtime'
import type { WireEvent } from '../wire'
import { addToTally, recordUsage, turnShortfall, usageOf } from '../usage'
import { runSteps } from './streams'
import { followWorkers } from './members'
import { displacedRuns } from './ownership'
import type { OutboxEntry } from './types'
import type { PromptProjection } from './projection'
import { cleanupPrompt } from './cleanup'
import { RunActivity } from './activity'

export async function* streamPrompt(state: PromptProjection, handles: RunHandles): AsyncGenerator<WireEvent> {
  const activity = new RunActivity(state.wake, state.queued)
  try {
    yield { t: 'run-start', runId: state.context.runId, members: handles.members }
    yield* readLeadSteps(state, handles, activity)
    const finalProgress = activity.finalProgress()
    if (finalProgress !== undefined) yield finalProgress
    yield* continueSteering(state, handles, activity)
    yield* completePrompt(state, handles)
  } catch (error) {
    yield* streamFailure(state, error)
  } finally {
    activity.close()
    await cleanupPrompt({ ...state.context, project: state.project, handles })
  }
}

async function* readLeadSteps(
  state: PromptProjection, handles: RunHandles, activity: RunActivity,
): AsyncGenerator<WireEvent> {
  const { live } = state.context
  for await (const step of runSteps(handles.events[Symbol.asyncIterator](), state.wake)) {
    // Record activity before judging silence, including events from workers.
    const active = 'lead' in step || state.queued.length > 0 || live.outbox.length > 0
    if (active) {
      const progress = activity.touch()
      if (progress !== undefined) yield progress
    }
    yield* drainQueued(state)
    yield* drainPromptOutbox(state)
    if ('lead' in step) {
      recordLeadSpend(state, step.lead)
      yield* projectLead(state, step.lead, activity)
    }
    if (!active) {
      const waitingOnUser = state.policy.pending().length > 0 || live.broker.pending().length > 0
      const progress = activity.silence(waitingOnUser)
      if (progress !== undefined) yield progress
    }
  }
}

function recordLeadSpend(state: PromptProjection, event: AgentRunEvent): void {
  const { id, group, runId, model, effort } = state.context
  const context = {
    conversationId: id, groupId: group.id, runId,
    provider: model.config.provider, model: model.config.model, effort,
  }
  const streamed = usageOf(event)
  if (streamed !== undefined) {
    addToTally(state.tally, undefined, streamed)
    void recordUsage(streamed, context)
  }
  void recordUsage(turnShortfall(event, state.tally), context)
}

function* projectLead(state: PromptProjection, event: AgentRunEvent, activity: RunActivity): Generator<WireEvent> {
  yield* state.trace.observe(event)
  for (const wire of state.project.forLead(event)) {
    activity.track(wire)
    yield wire
  }
}

async function* continueSteering(
  state: PromptProjection, handles: RunHandles, activity: RunActivity,
): AsyncGenerator<WireEvent> {
  const { live, controller } = state.context
  if (!live.steerUnread || handles.continuePending === undefined || controller.signal.aborted) return
  live.steerUnread = false
  for await (const event of handles.continuePending()) yield* projectLead(state, event, activity)
}

function* drainQueued(state: PromptProjection): Generator<WireEvent> {
  while (state.queued.length > 0) yield state.queued.shift() as WireEvent
}

async function* drainPromptOutbox(state: PromptProjection): AsyncGenerator<WireEvent> {
  const { live, controller, persist } = state.context
  while (!displacedRuns.has(controller) && live.outbox.length > 0) {
    const entry = live.outbox.shift() as OutboxEntry
    if (entry.node !== undefined) await persist(entry.node)
    if (entry.wire !== undefined) yield entry.wire
  }
}

async function* completePrompt(state: PromptProjection, handles: RunHandles): AsyncGenerator<WireEvent> {
  const { live, controller, persist } = state.context
  yield* drainQueued(state)
  yield* drainPromptOutbox(state)
  for (const node of state.project.flush()) await persist(node)
  yield* handleOutcome(state, handles)
  // Workers can outlive the lead; keep their stream open through the synthesis.
  yield* followWorkers(
    live, controller, state.wake, state.queued, state.project, persist, () => drainPromptOutbox(state),
  )
  for (const member of state.feed.open) yield { t: 'member-end', member }
  state.feed.open.clear()
}

async function* handleOutcome(state: PromptProjection, handles: RunHandles): AsyncGenerator<WireEvent> {
  if (handles.result === undefined) return
  const response = await handles.result
  const reason = response.outcome.reason
  if (reason.kind === 'error') {
    const { live, persist } = state.context
    const message = reason.failure.message
    await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
    yield { t: 'error', message }
  }
  yield { t: 'run-end', reason: reason.kind, text: response.text }
}

async function* streamFailure(state: PromptProjection, error: unknown): AsyncGenerator<WireEvent> {
  const { live, controller, persist } = state.context
  const message = error instanceof Error ? error.message : String(error)
  if (live.abort !== controller) {
    await persist({ kind: 'notice', id: `n_${String(live.seq)}`, level: 'warn', message })
    yield { t: 'notice', level: 'warn', message }
    yield { t: 'run-end', reason: 'aborted', text: '' }
  } else {
    await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
    yield { t: 'error', message }
  }
}
