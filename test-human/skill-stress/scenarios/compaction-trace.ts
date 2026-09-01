import { History } from '../../../src/agent/history/history.ts'
import { createMessage, createTextMessage } from '../../../src/core/message/message.ts'
import { createAgentCodeToolRegistry } from '../../agentcode/tools.ts'
import { createOfflineRegistry, createStressAgent } from '../agent.ts'
import { InvariantRecorder, StressObserver } from '../observer.ts'
import { ScriptedStressAdapter } from '../scripted-adapter.ts'
import type { StressCaseContext, StressScenarioResult } from '../types.ts'
import { consume, writeMetadataOnlyFixture } from './shared.ts'

export async function compactionTrace(
  context: StressCaseContext,
): Promise<StressScenarioResult> {
  const objectiveProbe = `ORIGINAL_OBJECTIVE_${context.seed}`
  const observer = new StressObserver(context.paths.report, { objective: objectiveProbe })
  const checks = new InvariantRecorder()
  try {
    await writeMetadataOnlyFixture(context.paths.skills)
    const adapter = new ScriptedStressAdapter({
      rounds: [{ finalText: 'Continued after the deterministic checkpoint.' }],
      compactionSummary: [
        '## Primary Request and Intent', `- Preserve ${objectiveProbe}.`,
        '## Progress and Completed Work', '- Earlier evidence was inspected.',
        '## Next Step', '- Continue after compaction.',
      ].join('\n'),
      onRequest(request, kind) { if (kind === 'compaction') observer.recordRequest(request, kind) },
    })
    const history = largeHistory(objectiveProbe)
    const agent = createStressAgent({
      id: `stress_compaction_${context.seed}`,
      provider: 'stress', model: 'scripted', effort: 'medium',
      skillRoots: [context.paths.skills], maxTurns: 4, maxToolCalls: 8,
      observer,
      compaction: {
        auto: true, maxInputTokens: 5_000, retainTokens: 300,
        maxSummaryTokens: 512, maxSummaryInputChars: 8_000,
        maxToolResultChars: 2_000, compactionRetries: 0, maxOverflowRetries: 0,
      },
    })
    const session = agent.createSession({
      registry: createOfflineRegistry(adapter), history,
      tools: createAgentCodeToolRegistry(context.paths.workspace), skillCwd: context.paths.workspace,
      hooks: {
        checkpoint(checkpoint) {
          if (checkpoint.kind === 'before-model-request') observer.recordRequest(checkpoint.request)
        },
      },
    })
    const outcome = await consume(session, 'Continue the original objective after checking retained state.', observer)
    const requests = observer.requests()
    const normal = requests.find(request => request.kind === 'model')
    const compact = requests.find(request => request.kind === 'compaction')
    const compactSpan = observer.events().find(event => event.type === 'span-start' && event.kind === 'compact')
    const historyKinds = session.history.entries().map(entry => entry.event.kind)

    checks.check('pressure compaction invokes a no-tool summarization request', compact !== undefined)
    checks.check('compaction lifecycle is committed in durable history',
      historyKinds.includes('compaction-summary') && historyKinds.includes('compaction-end'))
    checks.check('compaction lifecycle is streamed to GUI consumers', observer.events().some(event =>
      event.type === 'compaction-start') && observer.events().some(event => event.type === 'compaction-end'))
    checks.check('compaction has a correlated trace span', compactSpan !== undefined)
    checks.check('post-compaction model request retains metadata catalog only',
      normal?.systemHasCatalog === true && normal.systemHasSkillContent === false)
    checks.check('original objective survives in memory/checkpoint context',
      normal?.probes.objective?.messages === true)
    checks.check('trace has no missing, duplicate, or orphan spans', observer.traceProblems().length === 0,
      observer.traceProblems().join('; '))
    checks.check('turn continues after checkpoint', outcome?.reason.kind === 'completed')
    return { invariants: checks.items(), metrics: observer.metrics() }
  } finally {
    await observer.flush()
  }
}

function largeHistory(objectiveProbe: string): History {
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage(
    `${objectiveProbe}: preserve the original objective. ${'initial constraint '.repeat(900)}`,
  ) })
  history.append({ kind: 'assistant', message: modelMessage(
    `Inspected the first subsystem. ${'verified evidence '.repeat(900)}`,
  ) })
  history.append({ kind: 'user', message: createTextMessage(
    `Continue without losing decisions. ${'follow-up context '.repeat(700)}`,
  ) })
  history.append({ kind: 'assistant', message: modelMessage(
    `Prepared the next implementation step. ${'implementation note '.repeat(700)}`,
  ) })
  return history
}

function modelMessage(text: string) {
  return createMessage({
    role: 'assistant', source: { kind: 'model', provider: 'stress', model: 'scripted' },
    content: [{ type: 'text', text }],
  })
}
