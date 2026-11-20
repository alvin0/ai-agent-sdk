import { fileURLToPath, pathToFileURL } from 'node:url'
import { setImmediate } from 'node:timers/promises'

const tree = fileURLToPath(new URL('../../', import.meta.url))
const { AgentTeam } = await import(pathToFileURL(`${tree}/packages/core/src/agent/team/team.ts`))
if (!global.gc) throw new Error('Use --expose-gc --experimental-transform-types')
const count = 100
const payloadBytes = 64 * 1024
const held = []
const probes = new Map()
const team = new AgentTeam()
function payload(name) {
  const value = { bytes: new Uint8Array(payloadBytes) }
  const refs = probes.get(name) ?? []
  refs.push(new WeakRef(value))
  probes.set(name, refs)
  return value
}
function addCases(index) {
  const listenerPayload = payload('listener')
  const unsubscribe = team.subscribe(() => void listenerPayload.bytes.length)
  unsubscribe()
  held.push(unsubscribe)
  const wakePayload = payload('wake-guard')
  const removeWake = team.guardWake(() => void wakePayload.bytes.length)
  removeWake()
  held.push(removeWake)
  const waitPayload = payload('wait-guard')
  const removeWait = team.guardWait(() => void waitPayload.bytes.length)
  removeWait()
  held.push(removeWait)
  const remotePayload = payload('remote-transport')
  const unlink = team.linkAgent({ name: `remote-${index}`, transport: {
    protocol: 'fixture', agentId: `remote-agent-${index}`,
    async send() {
      void remotePayload.bytes.length
      return { kind: 'message', succeeded: true, text: 'done', contextId: 'fixture' }
    },
  } })
  unlink()
  held.push(unlink)
}
for (let index = 0; index < count; index++) addCases(index)
await team.dispose()
for (let index = 0; index < 5; index++) { await setImmediate(); global.gc() }
const alive = Object.fromEntries([...probes].map(([name, refs]) => [name, refs.filter(ref => ref.deref()).length]))
console.log(JSON.stringify({ heldDisposers: held.length, alive,
  members: team.members().length }))
