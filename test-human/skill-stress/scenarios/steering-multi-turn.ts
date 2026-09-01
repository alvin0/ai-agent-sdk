import { join } from 'node:path'
import type { AgentSession } from '../../../src/agent/define/session.ts'
import type { AgentRunOutcome } from '../../../src/agent/mode/run-agent.ts'
import { createAgentCodeToolRegistry } from '../../agentcode/tools.ts'
import { AgentCodeSteeringQueue } from '../../agentcode/steering.ts'
import { createOfflineRegistry, createStressAgent } from '../agent.ts'
import { InvariantRecorder, StressObserver } from '../observer.ts'
import { ScriptedStressAdapter } from '../scripted-adapter.ts'
import type { StressCaseContext, StressScenarioResult } from '../types.ts'
import { consume, optionalRead, writeMetadataOnlyFixture } from './shared.ts'

const STEERING_PROBE = 'STEERING_PROBE_3c97af61'

export async function steeringMultiTurn(
  context: StressCaseContext,
): Promise<StressScenarioResult> {
  const observer = new StressObserver(context.paths.report, { steering: STEERING_PROBE })
  const checks = new InvariantRecorder()
  try {
    await writeMetadataOnlyFixture(context.paths.skills)
    const adapter = new ScriptedStressAdapter({
      rounds: [
        {
          commentary: 'Load the relevant routing instructions first.',
          toolCalls: [{ name: 'load_skill', arguments: { skillId: 'checkpoint-routing' } }],
        },
        {
          commentary: 'Apply the steering instruction at this safe model boundary.',
          toolCalls: [{
            name: 'write_file',
            arguments: { path: 'steering-proof.txt', content: `${STEERING_PROBE}\n` },
          }],
        },
        { finalText: 'The steered first turn is complete.' },
        { finalText: 'The same conversation continued into a second turn.' },
      ],
      onRequest(request, kind) { if (kind === 'compaction') observer.recordRequest(request, kind) },
    })
    const agent = createStressAgent({
      id: `stress_steering_${context.seed}`,
      provider: 'stress', model: 'scripted', effort: 'medium',
      skillRoots: [context.paths.skills], maxTurns: 8, maxToolCalls: 12,
      compaction: false, observer,
    })
    let session: AgentSession
    const applied: string[] = []
    const steering = new AgentCodeSteeringQueue({
      onApplied(items) { applied.push(...items.map(item => item.id)) },
    })
    const steeringHooks = steering.hooks(() => session.history)
    session = agent.createSession({
      registry: createOfflineRegistry(adapter),
      tools: createAgentCodeToolRegistry(context.paths.workspace),
      skillCwd: context.paths.workspace,
      hooks: {
        ...steeringHooks,
        checkpoint(checkpoint) {
          if (checkpoint.kind === 'before-model-request') observer.recordRequest(checkpoint.request)
        },
      },
    })
    let queued = false
    let firstOutcome: AgentRunOutcome | undefined
    for await (const event of session.stream('Start the skill-guided task.')) {
      observer.recordEvent(event)
      if (!queued && event.type === 'tool-result' && event.call.toolName === 'load_skill') {
        steering.enqueue(`${STEERING_PROBE}: persist this marker in steering-proof.txt.`)
        queued = true
      }
      if (event.type === 'agent-end') firstOutcome = event.outcome
    }
    const secondOutcome = await consume(session, 'Continue using the same conversation state.', observer)
    const steeringRequest = observer.requests().find(request => request.probes.steering?.messages === true)
    const proof = await optionalRead(join(context.paths.workspace, 'steering-proof.txt'))
    const discoveryScans = observer.skillIo().filter(event =>
      event.phase === 'discovery' && event.operation === 'scan').length

    checks.check('steering is queued after a real skill result', queued)
    checks.check('steering applies exactly once at a safe boundary', applied.length === 1,
      `applied=${applied.length}`)
    checks.check('next model request contains the steering directive', steeringRequest !== undefined)
    checks.check('steered tool mutation persists the exact marker', proof?.includes(STEERING_PROBE) === true)
    checks.check('first steered turn completes', firstOutcome?.reason.kind === 'completed')
    checks.check('second user turn reuses the same live session', secondOutcome?.reason.kind === 'completed')
    checks.check('skill metadata is rediscovered before both user turns', discoveryScans >= 2,
      `discoveryScans=${discoveryScans}`)
    checks.check('multi-turn trace has no missing, duplicate, or orphan spans',
      observer.traceProblems().length === 0, observer.traceProblems().join('; '))
    return { invariants: checks.items(), metrics: observer.metrics() }
  } finally {
    await observer.flush()
  }
}
