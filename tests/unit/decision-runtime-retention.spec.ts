import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('releases cleaned provider captures while closed decision runtimes stay reachable', () => {
  const probe = fileURLToPath(new URL('../fixtures/decision-runtime-retention.mjs',
    import.meta.url))
  const output = execFileSync(process.execPath, ['--expose-gc', '--experimental-transform-types', probe], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  })
  const rows = output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  expect(rows.find(row => row.scenario === 'decision-closed-runtimes')).toMatchObject({
    count: 1000, cleanups: 1000, retainedCaptures: 0,
  })
  expect(rows.find(row => row.scenario === 'a2a-preaborted-promise')).toMatchObject({ unhandledRejections: 0 })
  expect(rows.find(row => row.scenario === 'a2a-client-preaborted-promise')).toMatchObject({ unhandledRejections: 0 })
})
