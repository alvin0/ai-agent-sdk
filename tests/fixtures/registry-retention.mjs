import { fileURLToPath, pathToFileURL } from 'node:url'
import { setImmediate } from 'node:timers/promises'

const tree = fileURLToPath(new URL('../../', import.meta.url))
const { ModelRegistry } = await import(pathToFileURL(`${tree}/packages/core/src/runtime/registry.ts`))
if (!global.gc) throw new Error('Use --expose-gc --experimental-transform-types')
const count = 100
const payloadBytes = 64 * 1024
const held = []
const probes = new Map()
const registry = new ModelRegistry()
function payload() { return { bytes: new Uint8Array(payloadBytes) } }
function retain(name, value) {
  const refs = probes.get(name) ?? []
  refs.push(new WeakRef(value))
  probes.set(name, refs)
}
function addCases(index) {
  const callbackPayload = payload()
  const listener = () => callbackPayload.bytes.length
  retain('listener-payload', callbackPayload)
  const unsubscribe = registry.onAdaptersUpdated(listener)
  unsubscribe()
  held.push(unsubscribe)

  const middlewarePayload = payload()
  const middleware = (_options, next) => { void middlewarePayload.bytes.length; return next() }
  retain('middleware-payload', middlewarePayload)
  const removeMiddleware = registry.use(middleware)
  removeMiddleware()
  held.push(removeMiddleware)

  const adapter = { bytes: new Uint8Array(payloadBytes), providerInfo: id => ({ id, name: 'Fixture' }),
    providerRetryPolicy: () => undefined }
  retain('adapter', adapter)
  const unregister = registry.registerAdapter([`route-${index}`], adapter)
  unregister()
  held.push(unregister)

  const pluginPayload = payload()
  retain('plugin-payload', pluginPayload)
  const uninstall = registry.install({ id: `plugin-${index}`, displayName: 'Fixture plugin',
    setup(registrar) {
      registrar.registerAdapter([`plugin-route-${index}`], {
        providerInfo: id => ({ id, name: 'Fixture' }), providerRetryPolicy: () => undefined,
      })
      return () => void pluginPayload.bytes.length
    },
  })
  uninstall()
  held.push(uninstall)
}
for (let index = 0; index < count; index++) addCases(index)
for (let index = 0; index < 5; index++) { await setImmediate(); global.gc() }
const alive = Object.fromEntries([...probes].map(([name, refs]) => [name, refs.filter(ref => ref.deref()).length]))
console.log(JSON.stringify({ heldDisposers: held.length, alive,
  providerCount: registry.listProviders().length }))
