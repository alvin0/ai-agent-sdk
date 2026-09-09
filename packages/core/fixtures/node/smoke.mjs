import assert from 'node:assert/strict'
import metadata from '@alvin0/ai-agent-sdk-core/package.json' with { type: 'json' }
import { ModelAdapter, ModelRegistry, createAgentRuntime, SDK_VERSION, createTraceId } from '@alvin0/ai-agent-sdk-core'
import { logicReviewEvidence } from './shared/logic-review.js'
import { overflowEvidence } from './shared/overflow.js'

class FixtureAdapter extends ModelAdapter {
  stream() {
    return (async function* () {
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

assert.match(createTraceId(), /^[0-9a-f]{32}$/)
assert.equal(SDK_VERSION, metadata.version)
const registry = new ModelRegistry()
registry.registerAdapter(['fixture'], new FixtureAdapter())
const call = registry.stream({ provider: 'fixture', model: 'model', messages: [] })
for await (const _chunk of call) { /* drain */ }
assert.deepEqual((await call.report).reported, { inputTokens: 1, outputTokens: 2, totalTokens: 3 })
assert.equal((await overflowEvidence({ ModelAdapter, ModelRegistry })).settled, true)
assert.equal((await logicReviewEvidence({ ModelAdapter, createAgentRuntime })).cancellation, true)
console.log('node:pass')
