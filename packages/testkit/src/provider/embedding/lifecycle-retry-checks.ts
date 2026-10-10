import {
  rejectionOf,
  codeOf,
  settled,
  groupBySignature,
} from './check-support.ts'
import {
  assert,
  within,
  required,
} from '../report.ts'
import {
  EMBEDDING_CONFORMANCE_DEFAULTS,
} from './config.ts'
import {
  corpusInputs,
  createCase,
  embeddingOptions,
  withRuntime,
  declaredLimits,
  dispatchBarrier,
  startRuntime,
  simpleInputs,
} from './case-support.ts'
import {
  ABORT_CODES,
  type CheckContext,
  DISPATCH_STATES,
} from './check-context.ts'
import {
  type RuntimeCloseReport,
} from '@alvin0/ai-agent-sdk-core'

export async function checkAbortStopsUnsent(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
  await check('embedding-abort-stops-unsent', async () => {
    const inputs = corpusInputs('abort')
    const candidate = createCase(fixture, 'embedding-abort-in-flight', inputs)
    const limits = declaredLimits(candidate, inputs.length)
    await withRuntime(candidate, timeouts, async (runtime) => {
      const controller = new AbortController()
      const call = runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose, signal: controller.signal,
      })
      await within(dispatchBarrier(candidate), budget)
      controller.abort()
      const failure = await rejectionOf(call, budget, 'an aborted embedding call')
      const code = codeOf(failure)
      assert(ABORT_CODES.has(code), `an aborted call surfaced "${code}" instead of a stable abort code`)
      const snapshot = candidate.control.snapshot()
      const sent = new Set(snapshot.dispatches.flatMap(dispatch => [...dispatch.itemIndexes]))
      assert(sent.size < inputs.length,
        'every input reached the provider despite the abort; unsent batches must stay unsent')
      const planned = Math.ceil(inputs.length / limits.maxItems)
      assert(snapshot.dispatches.length <= planned,
        `${snapshot.dispatches.length} attempts were spent for a call that plans ${planned} batches`)
    })
  })
}

export async function checkCloseCoversOperation(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
  await check('embedding-close-covers-operation', async () => {
    const inputs = corpusInputs('close')
    const candidate = createCase(fixture, 'embedding-abort-in-flight', inputs)
    const runtime = await startRuntime(candidate, timeouts)
    let report: RuntimeCloseReport | undefined
    let observed: Promise<unknown> | undefined
    try {
      const call = runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      })
      // Observed immediately, so closing never sees an unhandled rejection.
      observed = call.then(() => undefined, (error: unknown) => error)
      await within(dispatchBarrier(candidate), budget)
    } finally {
      report = await within(runtime.close(), timeouts.closeTimeoutMs + budget)
      const again = await runtime.close()
      assert(report === again, 'a second close produced a different report')
    }
    const closed = required(report)
    assert(closed.state === 'closed', 'the runtime did not reach the closed state')
    const summary = closed.operations.find(row => row.kind === 'embedding-call')
    assert(summary !== undefined, 'the close report carries no summary for the embedding operation kind')
    assert(summary.activeAtClose >= 1, 'the in-flight embedding call was not counted at close')
    for (const row of closed.operations) {
      assert(row.settled + row.unsettled === row.activeAtClose,
        `the close summary for "${row.kind}" does not balance against activeAtClose`)
    }
    assert(summary.aborted === summary.activeAtClose,
      'a live embedding call survived close without being aborted')
    const failure = await within(required(observed), budget)
    assert(failure !== undefined, 'an embedding call resolved after the runtime closed')
    const code = codeOf(failure)
    assert(ABORT_CODES.has(code), `close ended the call with "${code}" instead of a stable abort code`)
    assert(candidate.control.snapshot().cleanupCalls === 1, 'embedding provider cleanup count is not one')
  })
}

export async function checkRetryNoResend(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
  await check('embedding-retry-no-resend', async () => {
    const inputs = simpleInputs('retry')
    const candidate = createCase(fixture, 'embedding-retry-cost', inputs)
    await withRuntime(candidate, timeouts, async (runtime) => {
      // Either terminal outcome is a legitimate retry script, so the outcome
      // itself is not the claim; the attempt ledger is.
      await settled(runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      }), budget)
      const snapshot = candidate.control.snapshot()
      assert(snapshot.dispatches.length >= 2,
        'the retry scenario spent a single attempt, so no retry was exercised')
      for (const [signature, rows] of groupBySignature(snapshot.dispatches)) {
        const succeeded = rows.filter(row => !row.failed)
        assert(succeeded.length <= 1,
          `batch [${signature}] succeeded ${succeeded.length} times; a succeeded batch is never dispatched again`)
        if (succeeded.length === 1) {
          assert(rows.at(-1)?.failed === false,
            `batch [${signature}] was dispatched again after it had already succeeded`)
        }
      }
      const expected = candidate.expectedAttempts
      if (expected !== undefined) {
        assert(snapshot.dispatches.length === expected,
          `the scenario spent ${snapshot.dispatches.length} attempts, not the declared ${expected}`)
      }
    })
  })
}

export async function checkTimeoutDispatchUnknown(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
  await check('embedding-timeout-dispatch-unknown', async () => {
    const inputs = simpleInputs('timeout')
    const candidate = createCase(fixture, 'embedding-retry-cost', inputs)
    await withRuntime(candidate, timeouts, async (runtime) => {
      await settled(runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      }), budget)
      const ends = runtime.diagnostics().events.filter(
        event => event.name === 'sdk.provider.attempt' && event.phase === 'end',
      )
      assert(ends.length >= 1,
        'no provider attempt was recorded; an embedding attempt must report through the attempt ledger')
      const states = ends.map(event => String(event.data.dispatchState))
      for (const state of states) {
        assert(DISPATCH_STATES.has(state), `an attempt recorded the unrecognised dispatch state "${state}"`)
      }
      assert(states.includes('unknown'),
        'no attempt recorded dispatch state "unknown"; a request that never returned must not claim to know '
        + 'whether it reached the provider')
    })
  })
}
