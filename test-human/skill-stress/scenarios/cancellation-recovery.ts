import type { AgentRunOutcome } from '@ai-agent-sdk/core/agent'
import { defineTool } from '@ai-agent-sdk/core/agent'
import { createAgentCodeToolRegistry } from '../../agentcode/tools.ts'
import { createOfflineRegistry, createStressAgent } from '../agent.ts'
import { InvariantRecorder, StressObserver } from '../observer.ts'
import { ScriptedStressAdapter } from '../scripted-adapter.ts'
import type { StressCaseContext, StressScenarioResult } from '../types.ts'
import { consume, writeMetadataOnlyFixture } from './shared.ts'

export async function cancellationRecovery(
  context: StressCaseContext,
): Promise<StressScenarioResult> {
  const observer = new StressObserver(context.paths.report)
  const checks = new InvariantRecorder()
  try {
    await writeMetadataOnlyFixture(context.paths.skills)
    const adapter = new ScriptedStressAdapter({
      rounds: [
        {
          commentary: 'Start the cancellable host operation.',
          toolCalls: [{ name: 'slow_probe', arguments: {} }],
        },
        { finalText: 'The same session recovered on the next user turn.' },
      ],
      onRequest(request, kind) { if (kind === 'compaction') observer.recordRequest(request, kind) },
    })
    const agent = createStressAgent({
      id: `stress_cancel_${context.seed}`,
      provider: 'stress', model: 'scripted', effort: 'medium',
      skillRoots: [context.paths.skills], maxTurns: 4, maxToolCalls: 4,
      compaction: false, observer,
    })
    const tools = createAgentCodeToolRegistry(context.paths.workspace)
    tools.register(defineTool({
      name: 'slow_probe',
      description: 'Wait until the stress harness cancels this operation.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      parse: () => ({}),
      async execute(_value, toolContext) {
        await cancellableDelay(10_000, toolContext.signal)
        return { unexpectedlyCompleted: true }
      },
      timeoutMs: 15_000,
    }))
    const session = agent.createSession({
      registry: createOfflineRegistry(adapter), tools, skillCwd: context.paths.workspace,
      hooks: {
        checkpoint(checkpoint) {
          if (checkpoint.kind === 'before-model-request') observer.recordRequest(checkpoint.request)
        },
      },
    })
    const controller = new AbortController()
    let firstOutcome: AgentRunOutcome | undefined
    let firstError: unknown
    try {
      for await (const event of session.stream('Start the operation that will be cancelled.', {
        signal: controller.signal,
      })) {
        observer.recordEvent(event)
        if (event.type === 'tool-call' && event.call.toolName === 'slow_probe') {
          controller.abort(new Error('deterministic stress cancellation'))
        }
        if (event.type === 'agent-end') firstOutcome = event.outcome
      }
    } catch (error: unknown) {
      firstError = error
    }
    const secondOutcome = await consume(session, 'Recover and finish without rerunning the slow tool.', observer)
    const calls = session.history.entries().filter(entry => entry.event.kind === 'tool-call').length
    const results = session.history.entries().filter(entry => entry.event.kind === 'tool-result').length
    const abortedToolResult = observer.events().find(event =>
      event.type === 'tool-result' && event.call.toolName === 'slow_probe' && event.result.isError)

    checks.check('active host tool receives deterministic cancellation', controller.signal.aborted)
    checks.check('cancelled turn terminates as aborted or surfaces the abort reason',
      firstOutcome?.reason.kind === 'aborted' || firstError !== undefined)
    checks.check('cancelled tool records an error result for model/history pairing', abortedToolResult !== undefined)
    checks.check('cancelled history never leaves a dangling host tool call', calls === results,
      `calls=${calls}, results=${results}`)
    checks.check('session active guard is released and the next turn completes',
      secondOutcome?.reason.kind === 'completed')
    checks.check('recovery turn does not rerun the cancelled tool',
      observer.toolNames().filter(name => name === 'slow_probe').length === 1)
    checks.check('aborted and recovered trace spans are both closed',
      observer.traceProblems().length === 0, observer.traceProblems().join('; '))
    return { invariants: checks.items(), metrics: observer.metrics() }
  } finally {
    await observer.flush()
  }
}

function cancellableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error('cancelled')); return }
    const timer = setTimeout(finish, ms)
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('cancelled'))
    }
    function finish(): void {
      signal.removeEventListener('abort', abort)
      resolveDelay()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
