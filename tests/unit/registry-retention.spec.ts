import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('releases registry adapters and callbacks while disposed handles remain reachable', () => {
  const harness = fileURLToPath(new URL(
    '../fixtures/registry-retention.mjs', import.meta.url,
  ))
  const result = spawnSync(process.execPath, ['--expose-gc', '--experimental-transform-types', harness], {
    encoding: 'utf8', timeout: 20_000,
  })
  expect(result.status, result.stderr).toBe(0)
  const evidence = JSON.parse(result.stdout) as {
    heldDisposers: number
    alive: Record<string, number>
    providerCount: number
  }
  expect(evidence.heldDisposers).toBe(400)
  expect(evidence.alive).toEqual({ 'listener-payload': 0, 'middleware-payload': 0, adapter: 0, 'plugin-payload': 0 })
  expect(evidence.providerCount).toBe(0)
})
