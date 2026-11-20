import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('collects terminal report payloads while keeping a runtime without exporters open', () => {
  const script = fileURLToPath(new URL(
    '../../fixtures/no-exporter-retention.mjs', import.meta.url,
  ))
  expect(() => execFileSync(process.execPath, [
    '--expose-gc', '--experimental-transform-types', '--no-warnings', script,
  ], { timeout: 15_000, stdio: 'pipe' })).not.toThrow()
})
