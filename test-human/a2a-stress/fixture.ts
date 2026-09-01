import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { A2AStressMode } from './config.ts'

export interface A2AStressPaths {
  readonly workspace: string
  readonly results: string
}

const FIXTURE_MARKER = '.launchpad-a2a-fixture.json'
const FIXTURE_OWNER = 'ai-agent-sdk/test-human/a2a-stress'
const INTEGRITY_MANIFEST = 'host-owned-manifest.json'
const HOST_OWNED_PATHS = Object.freeze([
  'package.json', 'index.html', 'README.md', FIXTURE_MARKER,
  'scripts/build.mjs', 'scripts/run-tests.mjs', 'scripts/serve.mjs',
  'src/core/contracts.js', 'src/core/data.js', 'src/core/store.js',
  'tests/core.test.mjs',
  'product/brief.md', 'product/delivery.md', 'product/analytics.md', 'product/collaboration.md',
  'pressure/delivery.txt', 'pressure/analytics.txt', 'pressure/collaboration.txt',
])

export function a2aStressPaths(runId: string, mode: A2AStressMode): A2AStressPaths {
  const project = resolve(import.meta.dirname, '..', '..')
  const suffix = `${runId}-${mode}`
  return Object.freeze({
    workspace: join(project, 'test-human', 'workspaces', 'a2a-stress', suffix),
    results: join(project, 'test-human', 'results', 'a2a-stress', suffix),
  })
}

/** Seed a deterministic product skeleton whose three vertical slices can be built in parallel. */
export async function prepareA2AStressFixture(paths: A2AStressPaths): Promise<void> {
  await prepareOwnedWorkspace(paths.workspace)
  await Promise.all([
    mkdir(join(paths.workspace, 'product'), { recursive: true }),
    mkdir(join(paths.workspace, 'pressure'), { recursive: true }),
    mkdir(join(paths.workspace, 'src', 'core'), { recursive: true }),
    mkdir(join(paths.workspace, 'src', 'features'), { recursive: true }),
    mkdir(join(paths.workspace, 'tests'), { recursive: true }),
    mkdir(join(paths.workspace, 'docs'), { recursive: true }),
    mkdir(join(paths.workspace, 'scripts'), { recursive: true }),
    mkdir(paths.results, { recursive: true }),
  ])

  await Promise.all([
    write(paths, 'package.json', [
      '{',
      '  "name": "launchpad-ops-mvp",',
      '  "private": true,',
      '  "type": "module",',
      '  "scripts": {',
      '    "test": "node --test",',
      '    "build": "node scripts/build.mjs",',
      '    "preview": "node scripts/serve.mjs"',
      '  }',
      '}',
    ]),
    write(paths, 'index.html', [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '  <meta name="theme-color" content="#101827">',
      '  <meta name="description" content="LaunchPad Ops SaaS launch command center">',
      '  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'self\'">',
      '  <title>LaunchPad Ops</title>',
      '  <link rel="stylesheet" href="./src/styles.css">',
      '</head>',
      '<body>',
      '  <div id="app"><noscript>LaunchPad Ops requires JavaScript.</noscript></div>',
      '  <script type="module" src="./src/app.js"></script>',
      '</body>',
      '</html>',
    ]),
    write(paths, 'scripts/build.mjs', [
      "import { cp, mkdir, readFile, rm } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      '',
      "const required = ['delivery.js', 'analytics.js', 'collaboration.js']",
      "const markers = ['delivery-board', 'forecast-lab', 'decision-center']",
      "const sources = await Promise.all(required.map(name => readFile(join('src', 'features', name), 'utf8')))",
      "const app = await readFile(join('src', 'app.js'), 'utf8')",
      "for (const marker of markers) {",
      "  if (!sources.some(source => source.includes(marker))) throw new Error(`missing feature marker: ${marker}`)",
      "}",
      "if (!app.includes('launchpad-ops')) throw new Error('missing integrated app marker')",
      "await rm('dist', { recursive: true, force: true })",
      "await mkdir('dist', { recursive: true })",
      "await cp('index.html', join('dist', 'index.html'))",
      "await cp('src', join('dist', 'src'), { recursive: true })",
      "console.log('LaunchPad Ops built to dist/')",
    ]),
    write(paths, 'scripts/run-tests.mjs', [
      "import { readdir } from 'node:fs/promises'",
      "import { isAbsolute, relative, resolve, sep } from 'node:path'",
      "import { pathToFileURL } from 'node:url'",
      '',
      "const root = resolve('.')",
      "const testRoot = resolve(root, 'tests')",
      'const requested = process.argv.slice(2)',
      'const files = requested.length > 0',
      '  ? requested',
      "  : (await readdir(testRoot)).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`)",
      "if (files.length === 0) throw new Error('no website tests found')",
      'for (const file of files) {',
      '  const target = resolve(root, file)',
      '  const fromTests = relative(testRoot, target)',
      "  if (fromTests === '..' || fromTests.startsWith(`..${sep}`) || isAbsolute(fromTests) || !target.endsWith('.test.mjs')) {",
      "    throw new Error(`invalid test path: ${file}`)",
      '  }',
      '  await import(pathToFileURL(target).href)',
      '}',
    ]),
    write(paths, 'scripts/serve.mjs', [
      "import { createReadStream } from 'node:fs'",
      "import { stat } from 'node:fs/promises'",
      "import { createServer } from 'node:http'",
      "import { extname, join, normalize, resolve } from 'node:path'",
      '',
      "const root = resolve('dist')",
      'const port = Number(process.env.PORT ?? 4173)',
      "const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }",
      'const server = createServer(async (request, response) => {',
      "  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)",
      "  const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1))",
      '  const target = resolve(join(root, relative))',
      "  if (target !== root && !target.startsWith(`${root}${process.platform === 'win32' ? '\\\\' : '/'}`)) { response.writeHead(403).end(); return }",
      '  try {',
      '    if (!(await stat(target)).isFile()) throw new Error(\'not a file\')',
      "    response.writeHead(200, { 'content-type': types[extname(target)] ?? 'application/octet-stream' })",
      '    createReadStream(target).pipe(response)',
      "  } catch { response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found') }",
      '})',
      "server.listen(port, '127.0.0.1', () => console.log(`LaunchPad Ops: http://127.0.0.1:${port}`))",
    ]),
    write(paths, 'src/core/contracts.js', [
      "export const STATUSES = Object.freeze(['planned', 'active', 'review', 'done'])",
      "export const PRIORITIES = Object.freeze(['critical', 'high', 'medium', 'low'])",
      '',
      'export function escapeHtml(value) {',
      "  return String(value).replace(/[&<>\"']/g, character => ({",
      "    '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;',",
      '  })[character])',
      '}',
      '',
      'export function createId(prefix = \'item\') {',
      '  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`',
      '}',
      '',
      'export function formatMoney(value) {',
      "  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)",
      '}',
    ]),
    write(paths, 'src/core/data.js', [
      'export const initialState = Object.freeze({',
      "  project: { name: 'Atlas AI', launchDate: '2026-10-15', budget: 180000, spent: 73500 },",
      '  assumptions: { weeklyCapacity: 34, riskMultiplier: 1.15 },',
      '  tasks: [',
      "    { id: 'task-1', title: 'Finalize onboarding', owner: 'Maya', status: 'done', priority: 'critical', due: '2026-09-03', estimate: 8, blocked: false },",
      "    { id: 'task-2', title: 'Billing webhook hardening', owner: 'Noah', status: 'review', priority: 'critical', due: '2026-09-05', estimate: 13, blocked: false },",
      "    { id: 'task-3', title: 'Enterprise SSO', owner: 'Iris', status: 'active', priority: 'high', due: '2026-09-09', estimate: 21, blocked: true },",
      "    { id: 'task-4', title: 'Launch email sequence', owner: 'Leo', status: 'planned', priority: 'medium', due: '2026-09-12', estimate: 5, blocked: false },",
      "    { id: 'task-5', title: 'Security evidence pack', owner: 'Maya', status: 'active', priority: 'high', due: '2026-09-07', estimate: 13, blocked: false },",
      '  ],',
      '  decisions: [',
      "    { id: 'decision-1', title: 'Keep October launch window', owner: 'Nora', status: 'accepted', createdAt: '2026-08-29T09:00:00.000Z' },",
      '  ],',
      '  activity: [',
      "    { id: 'activity-1', type: 'delivery', text: 'Billing hardening moved to review', actor: 'Noah', at: '2026-08-31T08:10:00.000Z' },",
      "    { id: 'activity-2', type: 'risk', text: 'Enterprise SSO marked blocked', actor: 'Iris', at: '2026-08-31T07:40:00.000Z' },",
      "    { id: 'activity-3', type: 'decision', text: 'October launch window accepted', actor: 'Nora', at: '2026-08-30T16:20:00.000Z' },",
      '  ],',
      '})',
    ]),
    write(paths, 'src/core/store.js', [
      "import { initialState } from './data.js'",
      '',
      "const STORAGE_KEY = 'launchpad-ops:v1'",
      'const clone = value => structuredClone(value)',
      '',
      'export function createLaunchStore(storage = browserStorage()) {',
      '  let state = loadState(storage)',
      '  const listeners = new Set()',
      '  return Object.freeze({',
      '    getState: () => state,',
      '    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },',
      '    update(recipe, action = \'update\') {',
      '      const next = clone(state)',
      '      recipe(next)',
      '      next.meta = { action, updatedAt: new Date().toISOString() }',
      '      state = next',
      '      persist(storage, state)',
      '      for (const listener of listeners) listener(state)',
      '      return state',
      '    },',
      '    reset() { state = clone(initialState); persist(storage, state); for (const listener of listeners) listener(state) },',
      '  })',
      '}',
      '',
      'function browserStorage() {',
      "  try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined }",
      '}',
      '',
      'function loadState(storage) {',
      '  try {',
      '    const saved = storage?.getItem(STORAGE_KEY)',
      '    return saved ? { ...clone(initialState), ...JSON.parse(saved) } : clone(initialState)',
      '  } catch { return clone(initialState) }',
      '}',
      '',
      'function persist(storage, state) {',
      '  try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* MVP remains usable without storage. */ }',
      '}',
    ]),
    write(paths, 'tests/core.test.mjs', [
      "import test from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { escapeHtml } from '../src/core/contracts.js'",
      "import { createLaunchStore } from '../src/core/store.js'",
      '',
      "test('shared store commits and persists product mutations', () => {",
      '  const memory = new Map()',
      '  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }',
      '  const store = createLaunchStore(storage)',
      "  store.update(state => { state.project.name = 'Nova' }, 'rename')",
      "  assert.equal(store.getState().project.name, 'Nova')",
      "  assert.match([...memory.values()][0], /Nova/)",
      '})',
      '',
      "test('shared HTML boundary escapes unsafe labels', () => {",
      "  assert.equal(escapeHtml('<script>'), '&lt;script&gt;')",
      '})',
    ]),
    write(paths, 'product/brief.md', [
      '# LaunchPad Ops product brief',
      '',
      'LaunchPad Ops is a single-page command center for cross-functional SaaS launch teams.',
      'The product must turn delivery status, forecast risk, and launch decisions into one usable workflow.',
      '',
      '## Non-negotiable acceptance',
      '- It is an interactive website built from index.html and ES modules, with no external packages.',
      '- User mutations use the shared store and survive reload when localStorage is available.',
      '- Feature modules stay independently testable and expose pure domain helpers.',
      '- The layout works on desktop and mobile, with semantic labels and visible focus states.',
      '- npm test and npm run build must pass; dist/ is the deliverable.',
    ]),
    write(paths, 'product/delivery.md', [
      '# Delivery vertical slice',
      '- Render every work item with owner, status, priority, due date, estimate, and blocker badge.',
      '- Search title/owner, filter status, add a task, and advance status planned -> active -> review -> done.',
      '- Mutations must call store.update and append a delivery activity.',
      '- Export pure filterTasks and nextStatus helpers plus mountDelivery(root, store).',
      '- Own no files outside src/features/delivery.js, tests/delivery.test.mjs, docs/delivery.md.',
    ]),
    write(paths, 'product/analytics.md', [
      '# Forecast vertical slice',
      '- Derive completion percentage, blocker count, remaining effort, budget used, and forecast weeks.',
      '- Let users change weekly capacity and risk multiplier through labeled controls.',
      '- Render at least one meaningful SVG progress or trend visualization.',
      '- Export pure calculateMetrics and forecastWeeks helpers plus mountAnalytics(root, store).',
      '- Own no files outside src/features/analytics.js, tests/analytics.test.mjs, docs/analytics.md.',
    ]),
    write(paths, 'product/collaboration.md', [
      '# Collaboration vertical slice',
      '- Capture a decision title and owner, append it to the decision log and activity feed.',
      '- Filter activity by type and show an intentional empty state.',
      '- Export the current project state as a downloadable JSON snapshot.',
      '- Export pure filterActivity and serializeSnapshot helpers plus mountCollaboration(root, store).',
      '- Own no files outside src/features/collaboration.js, tests/collaboration.test.mjs, docs/collaboration.md.',
    ]),
    write(paths, 'pressure/delivery.txt', pressureText(
      'delivery',
      'Preserve the vertical-slice contract: searchable/filterable task cards, add and status advance actions, shared-store mutations, activity append, and DELIVERY-BOARD-READY.',
    )),
    write(paths, 'pressure/analytics.txt', pressureText(
      'analytics',
      'Preserve the vertical-slice contract: pure readiness and forecast math, capacity/risk controls, meaningful SVG, and FORECAST-LAB-READY.',
    )),
    write(paths, 'pressure/collaboration.txt', pressureText(
      'collaboration',
      'Preserve the vertical-slice contract: decision capture, typed activity filter, JSON export, shared-store persistence, and DECISION-CENTER-READY.',
    )),
    write(paths, 'README.md', [
      '# LaunchPad Ops A2A workspace',
      '',
      'This disposable workspace is intentionally incomplete.',
      'Three A2A specialists create feature slices concurrently; the coordinator integrates them.',
      '',
      'After a successful run:',
      '```sh',
      'npm test',
      'npm run build',
      'npm run preview',
      '```',
      'Then open the printed local URL to inspect the MVP.',
    ]),
    write(paths, FIXTURE_MARKER, [JSON.stringify({ owner: FIXTURE_OWNER, schemaVersion: 1 })]),
  ])
  await writeIntegrityManifest(paths)
}

export async function verifyA2AStressFixtureIntegrity(
  paths: A2AStressPaths,
): Promise<{ readonly passed: boolean; readonly detail: string }> {
  try {
    const expected = JSON.parse(
      await readFile(join(paths.results, INTEGRITY_MANIFEST), 'utf8'),
    ) as Record<string, string>
    const differences: string[] = []
    for (const relativePath of HOST_OWNED_PATHS) {
      const target = join(paths.workspace, relativePath)
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) {
        differences.push(`${relativePath}: not a plain file`)
        continue
      }
      const actual = sha256(await readFile(target))
      if (expected[relativePath] !== actual) differences.push(`${relativePath}: digest changed`)
    }
    return Object.freeze({
      passed: differences.length === 0,
      detail: differences.length === 0 ? `${HOST_OWNED_PATHS.length} protected files verified` : differences.join('; '),
    })
  } catch (error: unknown) {
    return Object.freeze({ passed: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

async function prepareOwnedWorkspace(workspace: string): Promise<void> {
  const info = await lstat(workspace).catch(error => isMissing(error) ? undefined : Promise.reject(error))
  if (info === undefined) return
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`LaunchPad workspace must be a plain directory: ${workspace}`)
  }
  const entries = await readdir(workspace)
  if (entries.length === 0) return
  let marker: { owner?: unknown } | undefined
  try { marker = JSON.parse(await readFile(join(workspace, FIXTURE_MARKER), 'utf8')) as { owner?: unknown } }
  catch { /* Checked below. */ }
  if (marker?.owner !== FIXTURE_OWNER) {
    throw new Error(`refusing to reset unowned LaunchPad workspace: ${workspace}`)
  }
  const canonicalWorkspace = await realpath(workspace)
  for (const relativePath of ['src', 'tests', 'docs', 'dist', 'scripts', 'product', 'pressure']) {
    const target = join(workspace, relativePath)
    const child = await lstat(target).catch(error => isMissing(error) ? undefined : Promise.reject(error))
    if (child === undefined) continue
    if (child.isSymbolicLink()) {
      throw new Error(`refusing to reset symlinked LaunchPad path: ${relativePath}`)
    }
    const canonical = await realpath(target)
    if (canonical !== canonicalWorkspace && !canonical.startsWith(`${canonicalWorkspace}${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`refusing to reset escaped LaunchPad path: ${relativePath}`)
    }
  }
  for (const relativePath of HOST_OWNED_PATHS) {
    const target = join(workspace, relativePath)
    const file = await lstat(target).catch(error => isMissing(error) ? undefined : Promise.reject(error))
    if (file?.isSymbolicLink() === true) {
      throw new Error(`refusing to overwrite symlinked LaunchPad file: ${relativePath}`)
    }
  }
  await Promise.all([
    rm(join(workspace, 'src', 'features'), { recursive: true, force: true }),
    rm(join(workspace, 'tests'), { recursive: true, force: true }),
    rm(join(workspace, 'docs'), { recursive: true, force: true }),
    rm(join(workspace, 'dist'), { recursive: true, force: true }),
    rm(join(workspace, 'src', 'app.js'), { force: true }),
    rm(join(workspace, 'src', 'styles.css'), { force: true }),
  ])
}

function pressureText(domain: string, critical: string): string[] {
  const lines = [
    `# ${domain} product-context archive`,
    'This repetitive discovery archive deliberately forces compaction while the agent builds a real feature.',
  ]
  for (let index = 1; index <= 280; index++) {
    lines.push(
      `interview=${String(index).padStart(3, '0')} domain=${domain} note=Launch operators need fast scanning, explicit ownership, keyboard-visible controls, trustworthy derived state, and recoverable local interaction.`,
    )
    if (index === 91 || index === 233) lines.push(`CRITICAL ${critical}`)
  }
  return lines
}

async function write(paths: A2AStressPaths, relativePath: string, lines: readonly string[]): Promise<void> {
  await writeFile(join(paths.workspace, relativePath), `${lines.join('\n')}\n`, 'utf8')
}

async function writeIntegrityManifest(paths: A2AStressPaths): Promise<void> {
  const manifest: Record<string, string> = {}
  for (const relativePath of HOST_OWNED_PATHS) {
    manifest[relativePath] = sha256(await readFile(join(paths.workspace, relativePath)))
  }
  await writeFile(
    join(paths.results, INTEGRITY_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'w' },
  )
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}
