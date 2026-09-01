import assert from 'node:assert/strict'
import { runPackedObservabilityFixture } from './fixture.mjs'

const savedBuffer = globalThis.Buffer
const savedProcess = globalThis.process
try {
  globalThis.Buffer = undefined
  globalThis.process = undefined
  assert.deepEqual(await runPackedObservabilityFixture(), {
    eventCount: 2,
    logLevel: 'warn',
    traceName: 'sdk.model.call',
    metricCount: 4,
    complete: true,
    healthy: 'healthy',
    safe: true,
    buffer: 'undefined',
    process: 'undefined',
  })
} finally {
  globalThis.Buffer = savedBuffer
  globalThis.process = savedProcess
}
console.log('standards:pass')
