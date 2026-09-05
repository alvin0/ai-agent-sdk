import assert from 'node:assert/strict'
import { overflowEvidence } from './shared/overflow.js'

const savedBuffer = globalThis.Buffer
const savedProcess = globalThis.process
try {
  globalThis.Buffer = undefined
  globalThis.process = undefined
  const sdk = await import('@ai-agent-sdk/core')
  assert.equal(typeof globalThis.Buffer, 'undefined')
  assert.equal(typeof globalThis.process, 'undefined')
  assert.match(sdk.createTraceId(), /^[0-9a-f]{32}$/)
  assert.equal((await overflowEvidence(sdk)).settled, true)
  const span = sdk.createCoreSpan({
    name: 'sdk.model.call',
    runId: 'standards-run',
    startedAt: new Date().toISOString(),
    monotonicMs: 0,
  })
  assert.match(span.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
} finally {
  globalThis.Buffer = savedBuffer
  globalThis.process = savedProcess
}
console.log('standards:pass')
