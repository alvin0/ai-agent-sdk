import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { HostE2eProbe } from './contracts.ts'

export async function createHostE2eProbe(workspace: string, port: number): Promise<HostE2eProbe> {
  const token = randomUUID().replaceAll('-', '')
  const specName = `.signal-desk-host-${token}.probe.ts`
  const configName = `.signal-desk-host-${token}.config.ts`
  const specPath = join(workspace, specName)
  const configPath = join(workspace, configName)
  const title = `Host probe critical ${token.slice(0, 8)}`
  const origin = `http://127.0.0.1:${port}`
  const spec = [
    "import { expect, test } from '@playwright/test'", '',
    "test('host-owned Signal Desk behavior', async ({ page }) => {",
    "  await page.goto('/')",
    "  await page.evaluate(() => localStorage.setItem('signal-desk:events:v2', '{corrupt'))",
    '  await page.reload()',
    "  await expect(page.getByRole('heading', { name: 'Signal Desk' })).toBeVisible()",
    "  await expect.poll(() => page.evaluate(() => localStorage.getItem('signal-desk:events:v2'))).toBeNull()",
    '  await page.evaluate(() => localStorage.clear())', '  await page.reload()',
    `  const title = ${JSON.stringify(title)}`,
    "  await page.getByLabel('What happened?').fill(title)",
    "  await page.getByLabel('Severity', { exact: true }).selectOption('critical')",
    "  await page.getByRole('button', { name: 'Add to desk' }).click()",
    '  await expect(page.getByRole(\'heading\', { name: title })).toBeVisible()',
    '  const status = page.getByLabel(`Status for ${title}`)',
    "  await status.selectOption('investigating')", "  await expect(status).toHaveValue('investigating')",
    "  await page.getByPlaceholder('Filter signals').fill(title)",
    '  await expect(page.getByRole(\'heading\', { name: title })).toBeVisible()',
    '  await page.reload()', '  await expect(page.getByRole(\'heading\', { name: title })).toBeVisible()',
    "  await expect(page.getByLabel(`Status for ${title}`)).toHaveValue('investigating')", '})', '',
  ].join('\n')
  const config = [
    "import { defineConfig } from '@playwright/test'", '', 'export default defineConfig({',
    "  testDir: '.',", `  testMatch: ${JSON.stringify(specName)},`, '  fullyParallel: false,',
    '  workers: 1,', "  reporter: 'line',", `  use: { baseURL: ${JSON.stringify(origin)}, trace: 'off', screenshot: 'off', video: 'off' },`,
    '  webServer: {', `    command: ${JSON.stringify(`npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`)},`,
    `    url: ${JSON.stringify(origin)},`, '    reuseExistingServer: false,', '    timeout: 120_000,', '  },', '})', '',
  ].join('\n')
  try {
    await writeFile(specPath, spec, { encoding: 'utf8', flag: 'wx' })
    await writeFile(configPath, config, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await Promise.all([rm(specPath, { force: true }), rm(configPath, { force: true })])
    throw error
  }
  return Object.freeze({
    commandArgs: Object.freeze(['exec', '--', 'playwright', 'test', specName, '--config', configName]),
    cleanup: async () => Promise.all([rm(specPath, { force: true }), rm(configPath, { force: true })]).then(() => undefined),
  })
}
export async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(); reject(new Error('could not allocate a loopback port for the host E2E probe')); return
      }
      server.close(error => { if (error !== undefined) reject(error); else resolvePromise(address.port) })
    })
  })
}
