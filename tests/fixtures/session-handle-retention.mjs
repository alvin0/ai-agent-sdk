import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const count = 10
assert.ok(global.gc, 'Run Node with --expose-gc')
const base = fileURLToPath(new URL('../../packages/core/src/', import.meta.url))
const modulePath = name => resolve(base, `${name}.ts`)
const load = name => import(pathToFileURL(modulePath(name)).href)
const [{ createRuntimeCompositionOwner }, { ModelAdapter }, { ModelRegistry }, { defineAgent }, { AgentSession }] =
  await Promise.all([load('composition/runtime/owner'), load('contract/adapter'), load('runtime/registry'),
    load('agent/define/definition'), load('agent/define/session')])

let sessions = [], histories = [], requests = []
// Observe ownership at the common session entry point without retaining any session or history strongly.
const original = AgentSession.prototype.createRunHandle
AgentSession.prototype.createRunHandle = function (...arguments_) {
  sessions.push(new WeakRef(this))
  histories.push(new WeakRef(this.history))
  return original.apply(this, arguments_)
}
class CompleteAdapter extends ModelAdapter {
  async * stream(options) {
    requests.push(new WeakRef(options))
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
const agent = runtime.agent({ id: 'handle-retention', instructions: 'Reply ok', compaction: false })
const registry = new ModelRegistry()
registry.registerAdapter(['offline'], new CompleteAdapter())
const defined = defineAgent({ id: 'define-retention', provider: 'offline', model: 'fixture',
  instructions: 'Reply ok', compaction: false })
async function collect() {
  for (let index = 0; index < 4; index++) { await setImmediate(); global.gc() }
}
const alive = references => references.filter(reference => reference.deref() !== undefined).length

async function verifyRetained(kept, api, retained) {
  for (const item of kept) {
    if (retained === 'iterator') {
      assert.equal((await item.value.next()).done, true)
      continue
    }
    assert.strictEqual(await item.value.result, item.result)
    assert.strictEqual(await item.value.report, item.report)
    item.value.abort(new Error('late abort'))
    if (api === 'define-session') assert.strictEqual(await item.value.seal(), item.report)
    if (retained === 'buffered') {
      let events = 0
      for await (const _event of item.value) {
        events++
        // Exercise consumer teardown after completion alongside full buffered replay.
        if (item.earlyBreak) break
      }
      assert.ok(events > 0, 'completed buffered events remain available')
    }
  }
}

try {
  for (const api of ['define-session', 'runtime-session', 'agent-stream']) {
    for (const retained of ['handle', 'iterator', 'buffered']) {
      sessions = []; histories = []; requests = []
      const kept = []
      await collect()
      async function run(index) {
        const payload = `private-history-${index}` + 'x'.repeat(65_536)
        let handle
        if (api === 'agent-stream') handle = agent.stream(payload)
        else {
          const session = api === 'define-session'
            ? defined.createSession({ registry, compaction: false }) : agent.createSession()
          session.inject(payload)
          handle = session.stream('answer ok')
        }
        let iterator
        if (retained !== 'buffered') {
          iterator = handle[Symbol.asyncIterator]()
          while (!(await iterator.next()).done) { /* drain events */ }
        }
        const result = await handle.result
        const report = await handle.report
        assert.equal(result.text, 'ok')
        kept.push({ value: retained === 'iterator' ? iterator : handle, result, report, earlyBreak: index % 2 === 0 })
      }
      for (let index = 0; index < count; index++) await run(index)
      await collect()
      assert.equal(alive(sessions), 0)
      assert.equal(alive(histories), 0)
      assert.equal(alive(requests), 0)
      await verifyRetained(kept, api, retained)
      kept.length = 0
      await collect()
    }
  }
} finally {
  AgentSession.prototype.createRunHandle = original
  await runtime.close()
}
