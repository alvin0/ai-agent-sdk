import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  seedSignalDeskWorkspace,
  SIGNAL_DESK_WORKSPACE_MARKER,
} from '../../test-human/agentcode/multi-skill/seed.ts'
import {
  verifySignalDeskWorkspace,
  type SignalDeskCommandResult,
  type SignalDeskCommandRunner,
} from '../../test-human/agentcode/multi-skill/verify.ts'
import { prepareSignalDeskWorkspace } from '../../test-human/agentcode/multi-skill/prepare.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })))
})

describe('Signal Desk host harness', () => {
  it('recognizes the real fixture gates while preserving its deliberate red baseline', async () => {
    const root = await temporaryDirectory()
    const workspace = join(root, 'real-fixture-workspace')
    const seeded = await seedSignalDeskWorkspace({ workspace })

    const report = await verifySignalDeskWorkspace({
      workspace,
      baseline: seeded.baseline,
      installDependencies: false,
      reinstallLockedDependencies: false,
      commandRunner: successfulRunner,
      hostProbePort: 43_120,
    })

    expect(report.checks.find(check => check.id === 'seeded-regressions-intact'))
      .toMatchObject({ passed: true })
    expect(report.checks.find(check => check.id === 'package-scripts'))
      .toMatchObject({ passed: true })
    expect(report.checks.find(check => check.id === 'package-toolchain'))
      .toMatchObject({ passed: true })
    expect(report.checks.find(check => check.id === 'source-fix'))
      .toMatchObject({ passed: false })
    expect(report.passed).toBe(false)
  })

  it('materializes seed templates and refuses to replace a foreign workspace', async () => {
    const root = await temporaryDirectory()
    const fixture = join(root, 'fixture')
    const workspace = join(root, 'workspace')
    await writeFixture(fixture)

    const seeded = await seedSignalDeskWorkspace({ workspace, fixtureRoot: fixture })

    expect(await readFile(join(workspace, 'src', 'App.tsx'), 'utf8')).toContain(
      'useSignalDesk()',
    )
    expect(seeded.baseline.files.map(file => file.path)).toContain('src/App.tsx')
    expect(seeded.baseline.files.map(file => file.path)).not.toContain('src/App.tsx.seed')
    expect(JSON.parse(await readFile(
      join(workspace, SIGNAL_DESK_WORKSPACE_MARKER),
      'utf8',
    ))).toMatchObject({ owner: 'ai-agent-sdk/test-human/agentcode/multi-skill' })

    const foreign = join(root, 'foreign')
    await mkdir(foreign)
    await writeFile(join(foreign, 'keep.txt'), 'do not remove', 'utf8')
    await expect(seedSignalDeskWorkspace({
      workspace: foreign,
      fixtureRoot: fixture,
      resetOwned: true,
    })).rejects.toThrow(/not owned/)
    expect(await readFile(join(foreign, 'keep.txt'), 'utf8')).toBe('do not remove')
  })

  it('attributes material changes and runs all acceptance commands', async () => {
    const root = await temporaryDirectory()
    const fixture = join(root, 'fixture')
    const workspace = join(root, 'workspace')
    await writeFixture(fixture)
    const seeded = await seedSignalDeskWorkspace({ workspace, fixtureRoot: fixture })

    await writeFile(join(workspace, 'src', 'App.tsx'), [
      "import { useSignalDesk } from './store/use-signal-desk'",
      'export default function App() {',
      '  const timeline = useSignalDesk(state => state.timeline)',
      '  const signals = useSignalDesk(state => state.signals)',
      '  return <main>{signals.map(signal => <article key={signal.id}>{signal.title}</article>)}{timeline.cursor}</main>',
      '}',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(workspace, 'src', 'domain', 'history.ts'), [
      'export const appendEvent = () => "fixed-redo-branch"',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(workspace, 'src', 'store', 'persistence.ts'), [
      "export const SIGNAL_DESK_STORAGE_KEY = 'signal-desk:events:v2'",
      'export function loadSignalDesk(storage: { getItem(key: string): string | null }) {',
      '  try { return JSON.parse(storage.getItem(SIGNAL_DESK_STORAGE_KEY) ?? "null") }',
      '  catch { return null }',
      '}',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(workspace, 'src', 'store', 'use-signal-desk.ts'), [
      'export const useSignalDesk = Object.assign((selector: (state: any) => any) => selector({ timeline: { cursor: 0 }, signals: [] }), { getState() {} })',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(workspace, 'src', 'store', 'storage-resilience.spec.ts'), [
      "import { expect, it } from 'vitest'",
      "it('survives disabled storage', () => {",
      "  const storage = { getItem() { throw new Error('disabled') }, setItem() { throw new Error('quota') }, removeItem() {} }",
      '  expect(() => storage.getItem()).toThrow()',
      '})',
      '',
    ].join('\n'), 'utf8')
    await mkdir(join(workspace, 'docs'))
    await writeFile(join(workspace, 'docs', 'verification.md'), [
      '# Verification',
      'Root cause and changes used systematic-debugging, vercel-react-best-practices, and playwright-skill.',
      '| Command | Exit code |',
      '| --- | ---: |',
      '| `npm test` | `0` |',
      '| `npm run build` | `0` |',
      '| `npm run e2e` | `0` |',
      '',
    ].join('\n'), 'utf8')
    await mkdir(join(workspace, 'e2e'))
    await writeFile(join(workspace, 'playwright.config.ts'), [
      'export default {',
      "  use: { baseURL: 'http://127.0.0.1:4173' },",
      "  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:4173' },",
      '}',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(workspace, 'e2e', 'signal-desk.spec.ts'), [
      "import { expect, test } from '@playwright/test'",
      "test.beforeEach(async ({ page }) => {",
      "  await page.goto('/')",
      '})',
      "test('create signal, filter, change status, and persist', async ({ page }) => {",
      "  await page.getByLabel('What happened?').fill('Critical database')",
      "  await page.getByLabel('Severity').selectOption('critical')",
      "  await page.getByRole('button', { name: 'Add to desk' }).click()",
      "  await page.getByPlaceholder('Filter signals').fill('Critical database')",
      "  const status = page.getByLabel('Status for Critical database')",
      "  await status.selectOption('investigating')",
      "  await expect(status).toHaveValue('investigating')",
      '  await page.reload()',
      "  await expect(page.getByRole('heading', { name: 'Critical database' })).toBeVisible()",
      '})',
      '',
    ].join('\n'), 'utf8')

    const called: string[] = []
    const runner: SignalDeskCommandRunner = async request => {
      called.push(request.name)
      const result: SignalDeskCommandResult = Object.freeze({
        name: request.name,
        command: 'npm',
        args: request.args,
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        durationMs: 1,
        stdout: 'ok',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      })
      return result
    }
    const report = await verifySignalDeskWorkspace({
      workspace,
      baseline: seeded.baseline,
      installDependencies: false,
      reinstallLockedDependencies: false,
      commandRunner: runner,
      hostProbePort: 43_123,
    })

    expect(called).toEqual(['regression', 'unit', 'build', 'e2e', 'host-e2e'])
    expect(report.passed).toBe(true)
    expect(report.checks.find(check => check.id === 'verification-document'))
      .toMatchObject({ passed: true })
    expect(report.checks.find(check => check.id === 'e2e-scenario'))
      .toMatchObject({ passed: true })
    expect(report.changes.modified).toEqual(expect.arrayContaining([
      'src/App.tsx',
      'src/domain/history.ts',
    ]))
    expect(report.changes.added).toEqual(expect.arrayContaining([
      'playwright.config.ts',
      'e2e/signal-desk.spec.ts',
    ]))
  })

  it('prefers npm ci and reports browser acquisition as a non-gating warning', async () => {
    const root = await temporaryDirectory()
    const fixture = join(root, 'fixture')
    const workspace = join(root, 'workspace')
    await writeFixture(fixture)
    await writeFile(join(fixture, 'package-lock.json'), '{}\n', 'utf8')
    await seedSignalDeskWorkspace({ workspace, fixtureRoot: fixture })

    const requests: { readonly name: string; readonly args: readonly string[] }[] = []
    const runner: SignalDeskCommandRunner = async request => {
      requests.push({ name: request.name, args: request.args })
      return Object.freeze({
        name: request.name,
        command: 'npm',
        args: request.args,
        exitCode: request.name === 'browser-install' ? 1 : 0,
        signal: null,
        timedOut: false,
        aborted: false,
        durationMs: 1,
        stdout: '',
        stderr: request.name === 'browser-install' ? 'transient download failure' : '',
        stdoutTruncated: false,
        stderrTruncated: false,
      })
    }

    const report = await prepareSignalDeskWorkspace({ workspace, commandRunner: runner })

    expect(requests).toEqual([
      expect.objectContaining({ name: 'install', args: expect.arrayContaining(['ci']) }),
      { name: 'browser-install', args: ['exec', '--', 'playwright', 'install', 'chromium'] },
    ])
    expect(report).toMatchObject({
      passed: true,
      dependenciesReady: true,
      browserInstallAttempted: true,
      browserReady: false,
    })
    expect(report.warnings.join(' ')).toMatch(/final E2E verification/i)
  })

  it('rejects deleted or assertion-weakened seeded regression specs', async () => {
    const root = await temporaryDirectory()
    const fixture = join(root, 'fixture')
    await writeFixture(fixture)

    const deletedWorkspace = join(root, 'deleted-workspace')
    const deletedSeed = await seedSignalDeskWorkspace({
      workspace: deletedWorkspace,
      fixtureRoot: fixture,
    })
    await rm(join(deletedWorkspace, 'src', 'domain', 'history.spec.ts'))
    const deletedReport = await verifySignalDeskWorkspace({
      workspace: deletedWorkspace,
      baseline: deletedSeed.baseline,
      installDependencies: false,
      reinstallLockedDependencies: false,
      commandRunner: successfulRunner,
      hostProbePort: 43_124,
    })
    expect(deletedReport.checks.find(check => check.id === 'seeded-regressions-intact'))
      .toMatchObject({ passed: false })

    const weakenedWorkspace = join(root, 'weakened-workspace')
    const weakenedSeed = await seedSignalDeskWorkspace({
      workspace: weakenedWorkspace,
      fixtureRoot: fixture,
    })
    await writeFile(
      join(weakenedWorkspace, 'src', 'store', 'persistence.spec.ts'),
      "import { expect, it } from 'vitest'\nit('always green', () => expect(true).toBe(true))\n",
      'utf8',
    )
    const weakenedReport = await verifySignalDeskWorkspace({
      workspace: weakenedWorkspace,
      baseline: weakenedSeed.baseline,
      installDependencies: false,
      reinstallLockedDependencies: false,
      commandRunner: successfulRunner,
      hostProbePort: 43_125,
    })
    expect(weakenedReport.checks.find(check => check.id === 'seeded-regressions-intact'))
      .toMatchObject({ passed: false })
  })

  it('rejects keyword-only E2E prose and no-op release scripts', async () => {
    const root = await temporaryDirectory()
    const fixture = join(root, 'fixture')
    const workspace = join(root, 'workspace')
    await writeFixture(fixture)
    const seeded = await seedSignalDeskWorkspace({ workspace, fixtureRoot: fixture })
    await mkdir(join(workspace, 'e2e'))
    await writeFile(join(workspace, 'playwright.config.ts'), [
      'export default {',
      "  use: { baseURL: 'http://127.0.0.1:4173' },",
      "  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:4173' },",
      '}',
    ].join('\n'), 'utf8')
    await writeFile(join(workspace, 'e2e', 'superficial.spec.ts'), [
      "import { expect, test } from '@playwright/test'",
      '// page.goto; What happened fill critical selectOption; Add to desk click',
      '// Filter signals; Status for investigating; page.reload; toBeVisible; toHaveValue',
      'async function unused(page: any) {',
      "  await page.goto('/')",
      "  await page.getByLabel('What happened?').fill('critical')",
      "  await page.getByLabel('Severity').selectOption('critical')",
      "  await page.getByRole('button', { name: 'Add to desk' }).click()",
      "  await page.getByPlaceholder('Filter signals').fill('critical')",
      "  await page.getByLabel('Status for critical').selectOption('investigating')",
      '  await page.reload()',
      "  await expect(page.getByText('critical')).toBeVisible()",
      "  await expect(page.getByLabel('Status for critical')).toHaveValue('investigating')",
      '}',
      "test('words are not behavior', async () => { expect(true).toBe(true) })",
      '',
    ].join('\n'), 'utf8')
    const packagePath = join(workspace, 'package.json')
    const packageValue = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts: Record<string, string>
    }
    packageValue.scripts.test = 'node -e "process.exit(0)"'
    packageValue.scripts.build = 'node -e "process.exit(0)"'
    packageValue.scripts.e2e = 'node -e "process.exit(0)"'
    await writeFile(packagePath, `${JSON.stringify(packageValue, null, 2)}\n`, 'utf8')

    const report = await verifySignalDeskWorkspace({
      workspace,
      baseline: seeded.baseline,
      installDependencies: false,
      reinstallLockedDependencies: false,
      commandRunner: successfulRunner,
      hostProbePort: 43_126,
    })

    expect(report.checks.find(check => check.id === 'e2e-scenario'))
      .toMatchObject({ passed: false })
    expect(report.checks.find(check => check.id === 'package-scripts'))
      .toMatchObject({ passed: false })
    expect(report.passed).toBe(false)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentcode-signal-desk-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeFixture(root: string): Promise<void> {
  await Promise.all([
    mkdir(join(root, 'src', 'domain'), { recursive: true }),
    mkdir(join(root, 'src', 'store'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(root, 'package.json'), `${JSON.stringify({
      scripts: {
        test: 'npm run test:unit',
        'test:unit': 'vitest run',
        build: 'tsc -b && vite build',
        'test:e2e': 'playwright test',
        e2e: 'playwright test',
      },
      dependencies: {
        react: '19.2.8',
        'react-dom': '19.2.8',
        zustand: '5.0.15',
      },
      devDependencies: {
        '@playwright/test': '1.62.1',
        typescript: '6.0.2',
        vite: '8.2.2',
        vitest: '4.1.11',
      },
    }, null, 2)}\n`, 'utf8'),
    writeFile(join(root, 'package-lock.json'), '{}\n', 'utf8'),
    writeFile(join(root, 'tsconfig.json'), '{}\n', 'utf8'),
    writeFile(join(root, 'tsconfig.app.json'), '{}\n', 'utf8'),
    writeFile(join(root, 'tsconfig.node.json'), '{}\n', 'utf8'),
    writeFile(join(root, 'vite.config.ts.seed'), 'export default { test: { include: [\'src/**/*.spec.ts\'] } }\n', 'utf8'),
    writeFile(join(root, 'src', 'App.tsx.seed'), [
      'export default function App() {',
      '  const desk = useSignalDesk()',
      '  return desk.visible.map((item, index) => <div key={index}>{item}</div>)',
      '}',
      '',
    ].join('\n'), 'utf8'),
    writeFile(join(root, 'src', 'domain', 'history.ts.seed'), 'export const broken = true\n', 'utf8'),
    writeFile(join(root, 'src', 'domain', 'history.spec.ts.seed'), 'expect("history regression").toBeTruthy()\n', 'utf8'),
    writeFile(join(root, 'src', 'store', 'persistence.ts.seed'), 'export const storage = true\n', 'utf8'),
    writeFile(join(root, 'src', 'store', 'persistence.spec.ts.seed'), 'expect("persistence regression").toBeTruthy()\n', 'utf8'),
    writeFile(join(root, 'src', 'store', 'use-signal-desk.ts.seed'), 'export const useSignalDesk = () => ({})\n', 'utf8'),
  ])
}

const successfulRunner: SignalDeskCommandRunner = async request => Object.freeze({
  name: request.name,
  command: 'npm',
  args: request.args,
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  durationMs: 1,
  stdout: 'ok',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
})
