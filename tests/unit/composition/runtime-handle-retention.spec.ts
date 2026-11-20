import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('releases completed session ownership while retaining handles, iterators, results and replayable events', () => {
  const script = fileURLToPath(new URL(
    '../../fixtures/session-handle-retention.mjs', import.meta.url,
  ))
  expect(() => execFileSync(process.execPath, [
    '--expose-gc', '--experimental-transform-types', '--no-warnings', script,
  ], { timeout: 15_000, stdio: 'pipe' })).not.toThrow()
})
