/** Actual installed public SDK contracts, including uncooperative callbacks. */
export async function logicReviewEvidence({ ModelAdapter, createAgentRuntime }) {
  class Adapter extends ModelAdapter {
    calls = 0
    async * stream() {
      this.calls++
      yield { type: 'usage', usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE', message: 'retry fixture' } } }
    }
  }
  const adapter = new Adapter()
  const runtime = await createAgentRuntime({ providers: [{
    kind: 'model-provider-plugin', apiVersion: 1, id: 'logic', displayName: 'Logic',
    routes: ['logic'], defaultModel: { provider: 'logic', id: 'model' },
    setup(registrar) { registrar.registerAdapter(['logic'], adapter) },
  }] })
  let timer
  try {
    const work = async () => {
      const result = await runtime.agent({ id: 'budget', instructions: 'Go', compaction: false })
        .createSession({ runtimeLimits: { maxTotalTokens: 100 }, hooks: { onRequestError: () => 'retry' } }).run('go')
      if (adapter.calls !== 1 || result.completed !== false || result.stopReason !== 'budget-exhausted'
        || result.report.status !== 'success') throw new Error('packed admission/completion contract failed')
      adapter.stream = async function* () {
        this.calls++
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      let entered
      const ready = new Promise(resolve => { entered = resolve })
      const session = runtime.agent({ id: 'estimator', instructions: 'Go', compaction: false }).createSession({
        usagePolicy: { onMissing: 'estimate', estimator: { id: 'never', estimate: () => {
          entered()
          return new Promise(() => {})
        } } },
      })
      const handle = session.stream('go')
      const settled = handle.result.then(() => false, () => true)
      await ready
      handle.abort()
      if (!await settled || session.isRunning || (await handle.report).modelCalls.length !== 1) {
        throw new Error('packed estimator cancellation contract failed')
      }
      for (const onMissing of ['fail', 'warn']) {
        const requests = []
        adapter.stream = async function* (request) {
          requests.push(request.model)
          yield { type: 'text-delta', index: 0, text: 'Checkpoint.' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Checkpoint.' } }
          if (request.model !== 'summary') yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
        const compacting = runtime.agent({ id: `compaction-${onMissing}`, instructions: 'Go', compaction: {
          auto: true, summarizationProvider: 'logic', summarizationModel: 'summary',
          maxInputTokens: 100, retainTokens: 10, compactionRetries: 2,
        } }).createSession({ usagePolicy: { onMissing }, runtimeLimits: { maxTotalTokens: 100 } })
        compacting.inject('Prior context '.repeat(1_000))
        const run = compacting.stream('Go.')
        const result = await run.result.then(value => value, error => error)
        const report = await run.report
        if (JSON.stringify(requests) !== '["summary"]' || report.modelCalls.length !== 1
          || (onMissing === 'fail' ? result.code !== 'USAGE_REQUIRED'
            : result.completed !== false || result.stopReason !== 'usage-unavailable')) {
          throw new Error('packed compaction mandatory usage stop failed')
        }
      }
      return { admission: true, completion: true, cancellation: true, compaction: true }
    }
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('packed logic fixture exceeded 5 seconds')), 5_000)
    })])
  } finally { clearTimeout(timer); await runtime.close() }
}
