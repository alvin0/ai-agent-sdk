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
      return { admission: true, completion: true, cancellation: true }
    }
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('packed logic fixture exceeded 5 seconds')), 5_000)
    })])
  } finally { clearTimeout(timer); await runtime.close() }
}
