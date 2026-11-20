// The diagnostic ring and bounded identity metadata remain owned by the runtime.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const count = 20
assert.ok(global.gc, 'Run Node with --expose-gc')
const base = fileURLToPath(new URL('../../packages/core/src/', import.meta.url))
const modulePath = name => resolve(base, `${name}.ts`)
const load = name => import(pathToFileURL(modulePath(name)).href)
const [{ createRuntimeCompositionOwner }, { ModelAdapter }, { DeliveryQueueStore }] = await Promise.all([
  load('composition/runtime/owner'), load('contract/adapter'), load('composition/queue/store'),
])
const records = []
let store
const admitRecord = DeliveryQueueStore.prototype.admitRunRecord
DeliveryQueueStore.prototype.admitRunRecord = function (input) {
  store = this
  records.push(new WeakRef(input))
  return admitRecord.call(this, input)
}
class CompleteAdapter extends ModelAdapter {
  async * stream() {
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const runtime = await createRuntimeCompositionOwner({ providers: [{
  kind: 'model-provider-plugin', apiVersion: 1, id: 'fixture', displayName: 'Fixture', family: 'offline',
  routes: ['offline'], defaultModel: { provider: 'offline', id: 'fixture' },
  setup(registrar) { registrar.registerAdapter(['offline'], new CompleteAdapter()) },
}] })
const agent = runtime.agent({ id: 'queue-probe', instructions: 'Reply ok', compaction: false })
async function collect() {
  for (let index = 0; index < 4; index++) { await setImmediate(); global.gc() }
}
const alive = references => references.filter(reference => reference.deref() !== undefined).length

try {
  for (let index = 0; index < count; index++) {
    const result = await agent.createSession().run('ok')
    assert.equal(result.text, 'ok')
  }
  await collect()
  assert.equal(store.stats().queuedItems, 0)
  assert.equal(store.stats().queuedBytes, 0)
  assert.equal(alive(records), 0)
  for (const identities of [store.eventIds, store.runIds]) {
    for (const entry of identities.values()) assert.ok(!('item' in entry))
  }
} finally {
  DeliveryQueueStore.prototype.admitRunRecord = admitRecord
  await runtime.close()
}
