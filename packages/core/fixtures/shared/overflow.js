/** Exercise installed public APIs; no Node globals or provider network request. */
export async function overflowEvidence({ ModelAdapter, ModelRegistry }) {
  class Adapter extends ModelAdapter {
    async * stream(options, context) {
      context.declareProviderAttemptAccounting()
      const attempt = await context.startProviderAttempt({
        provider: options.provider, model: options.model, method: 'POST', origin: 'https://fixture.invalid',
      })
      const reported = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER }
      attempt.end({ status: 'success', dispatchState: 'sent', reported })
      yield { type: 'usage', usage: reported }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const registry = new ModelRegistry()
  registry.registerAdapter(['overflow'], new Adapter())
  const call = registry.stream({ provider: 'overflow', model: 'fixture', messages: [] })
  let timer
  const expired = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('overflow report did not settle')), 2_000) })
  try {
    const report = await Promise.race([(async () => {
      for await (const _chunk of call) { /* drain */ }
      return call.report
    })(), expired])
    if (report.authoritative !== false || report.error?.code !== 'USAGE_COUNTER_OVERFLOW'
      || report.attempts.length !== 1 || report.reported.inputTokens !== Number.MAX_SAFE_INTEGER
      || report.reported.outputTokens !== 1) throw new Error('overflow accounting evidence is invalid')
    return { settled: true, authoritative: report.authoritative, errorCode: report.error.code, attempts: report.attempts.length }
  } finally { clearTimeout(timer) }
}
