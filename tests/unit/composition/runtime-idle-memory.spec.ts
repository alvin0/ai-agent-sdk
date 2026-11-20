import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('collects cancelled idle waiters while the session operation remains active', () => {
  const owner = new URL('../../../packages/core/src/composition/runtime/owner.ts', import.meta.url).href
  const adapter = new URL('../../../packages/core/src/contract/adapter.ts', import.meta.url).href
  const script = `
    import { createRuntimeCompositionOwner } from ${JSON.stringify(owner)}
    import { ModelAdapter } from ${JSON.stringify(adapter)}
    import assert from 'node:assert/strict'

    class BlockingAdapter extends ModelAdapter {
      release
      blocked = new Promise(resolve => { this.release = resolve })
      async * stream() {
        await this.blocked
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const adapter = new BlockingAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [{
      kind: 'model-provider-plugin', apiVersion: 1, id: 'idle-memory', displayName: 'Idle memory',
      family: 'offline', routes: ['offline'], defaultModel: { provider: 'offline', id: 'offline' },
      setup(registrar) { registrar.registerAdapter(['offline'], adapter) },
    }] })
    const session = runtime.agent({ id: 'idle-memory', instructions: 'Wait', compaction: false }).createSession()
    const handle = session.stream('wait')
    void handle.result.catch(() => undefined)
    const references = []
    async function cancelWaiter() {
      const caller = new AbortController()
      references.push(new WeakRef(caller.signal))
      const waiting = session.whenIdle(caller.signal)
      caller.abort()
      await assert.rejects(waiting, { code: 'RUNTIME_OPERATION_ABORTED' })
    }
    for (let index = 0; index < 100; index++) await cancelWaiter()
    await new Promise(resolve => setImmediate(resolve))
    for (let index = 0; index < 4; index++) globalThis.gc()
    assert.equal(session.isRunning, true)
    const retained = references.filter(reference => reference.deref() !== undefined).length
    assert.equal(retained, 0, 'cancelled waiter signals must be collectible before the run completes')
    const idle = session.whenIdle()
    handle.abort()
    adapter.release()
    await handle.result.catch(() => undefined)
    await idle
    assert.equal(session.isRunning, false)
    await runtime.close()
  `
  expect(() => execFileSync(process.execPath, [
    '--expose-gc', '--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', script,
  ], { timeout: 15_000, stdio: 'pipe' })).not.toThrow()
})
