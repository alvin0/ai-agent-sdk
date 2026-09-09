import { join } from 'node:path'
import { readBoundedText, readJsonObject, objectProperty, firstExistingFile, findE2eSpecs } from './filesystem.ts'
import { PROTECTED_BASELINE_FILES, type SignalDeskFileChanges } from './contracts.ts'
import type { SignalDeskBaseline } from '../seed.ts'

type Check = (id: string, name: string, passed: boolean, detail?: string, required?: boolean) => void

export async function runStaticVerificationChecks(
  workspace: string,
  baseline: SignalDeskBaseline | undefined,
  changes: SignalDeskFileChanges,
  check: Check,
): Promise<void> {
  const packageValue = await readJsonObject(join(workspace, 'package.json'))
  const scripts = objectProperty(packageValue, 'scripts')
  const normalizedScripts = Object.fromEntries(Object.entries(scripts ?? {}).map(
    ([name, value]) => [name, typeof value === 'string' ? normalizeCommand(value) : value],
  ))
  const scriptProblems = [
    ...(normalizedScripts.test === 'npm run test:unit' ? [] : ['test']),
    ...(normalizedScripts['test:unit'] === 'vitest run' ? [] : ['test:unit']),
    ...(normalizedScripts.build === 'tsc -b && vite build' ? [] : ['build']),
    ...(normalizedScripts['test:e2e'] === 'playwright test' ? [] : ['test:e2e']),
    ...(
      normalizedScripts.e2e === 'playwright test'
      || normalizedScripts.e2e === 'npm run test:e2e'
        ? []
        : ['e2e']
    ),
  ]
  check(
    'package-scripts',
    'release scripts retain the real Vitest, TypeScript/Vite, and Playwright gates',
    scriptProblems.length === 0,
    scriptProblems.length === 0 ? undefined : `unsafe-or-missing=${scriptProblems.join(',')}`,
  )
  const dependencies = objectProperty(packageValue, 'dependencies')
  const devDependencies = objectProperty(packageValue, 'devDependencies')
  const dependencyProblems = Object.entries({
    react: '19.2.8',
    'react-dom': '19.2.8',
    zustand: '5.0.15',
  }).filter(([name, version]) => dependencies?.[name] !== version).map(([name]) => name)
  const devDependencyProblems = Object.entries({
    '@playwright/test': '1.62.1',
    typescript: '6.0.2',
    vite: '8.2.2',
    vitest: '4.1.11',
  }).filter(([name, version]) => devDependencies?.[name] !== version).map(([name]) => name)
  check(
    'package-toolchain',
    'the pinned runtime and test toolchain cannot be replaced with no-op packages',
    [...dependencyProblems, ...devDependencyProblems].length === 0,
    [...dependencyProblems, ...devDependencyProblems].length === 0
      ? undefined
      : `changed-or-missing=${[...dependencyProblems, ...devDependencyProblems].join(',')}`,
  )

  const coreFiles = [
    'src/App.tsx',
    'src/domain/history.ts',
    'src/store/persistence.ts',
    'src/store/use-signal-desk.ts',
  ]
  const deletedCoreFiles = changes.deleted.filter(path => coreFiles.includes(path))
  check(
    'core-files-preserved',
    'the exercise is solved without deleting its core implementation',
    deletedCoreFiles.length === 0,
    deletedCoreFiles.length === 0 ? undefined : `deleted=${deletedCoreFiles.join(',')}`,
  )

  const baselinePaths = new Set(baseline?.files.map(file => file.path) ?? [])
  const protectedProblems = [
    ...PROTECTED_BASELINE_FILES.filter(path =>
      !baselinePaths.has(path) || changes.modified.includes(path) || changes.deleted.includes(path)),
    ...changes.added.filter(path => /^vitest\.config\.[cm]?[jt]s$/.test(path)),
  ]
  check(
    'seeded-regressions-intact',
    'seeded specs, lockfile, and build/test configs remain byte-for-byte intact',
    protectedProblems.length === 0,
    protectedProblems.length === 0 ? undefined : `changed-or-missing=${protectedProblems.join(',')}`,
  )

  const fixCandidates = [
    'src/domain/history.ts',
    'src/store/persistence.ts',
    'src/store/use-signal-desk.ts',
  ]
  const changedFixes = changes.modified.filter(path => fixCandidates.includes(path))
  check(
    'source-fix',
    'history, persistence, and store integration were all corrected',
    fixCandidates.every(path => changedFixes.includes(path)),
    `changed=${changedFixes.join(',') || 'none'}`,
  )

  const persistenceText = await readBoundedText(join(workspace, 'src', 'store', 'persistence.ts'))
  const persistenceProblems = [
    ...(persistenceText?.includes('signal-desk:events:v2') === true ? [] : ['versioned v2 key']),
    ...(persistenceText !== undefined && /\btry\s*\{/.test(persistenceText)
      && /\bcatch\b/.test(persistenceText)
      ? []
      : ['storage failures are not guarded']),
  ]
  check(
    'persistence-contract',
    'persistence uses the v2 durable-event key and guards storage failures',
    persistenceProblems.length === 0,
    persistenceProblems.length === 0 ? undefined : persistenceProblems.join('; '),
  )

  const appText = await readBoundedText(join(workspace, 'src', 'App.tsx'))
  const appChanged = changes.modified.includes('src/App.tsx')
  const wholeStoreSubscription = appText === undefined || /useSignalDesk\s*\(\s*\)/.test(appText)
  const mirroredFilteredState = appText !== undefined
    && (/setFiltered\w*\s*\(/.test(appText) || /useEffect\s*\([\s\S]{0,800}filter\s*\(/i.test(appText))
  const indexKey = appText !== undefined && /key\s*=\s*\{\s*(?:index|i)\s*\}/.test(appText)
  const stableSignalKey = appText !== undefined && /key\s*=\s*\{\s*signal\.id\s*\}/.test(appText)
  const repeatedSignalScans = (appText?.match(/\b(?:allSignals|signals)\s*\.\s*filter\s*\(/g) ?? []).length > 1
  const reactProblems = [
    ...(appChanged ? [] : ['App.tsx unchanged']),
    ...(wholeStoreSubscription ? ['whole-store subscription remains'] : []),
    ...(mirroredFilteredState ? ['filtered data remains mirrored through an effect'] : []),
    ...(indexKey ? ['list index key remains'] : []),
    ...(stableSignalKey ? [] : ['signal identity is not keyed by signal.id']),
    ...(repeatedSignalScans ? ['signals are repeatedly scanned with filter during render'] : []),
  ]
  check(
    'react-refactor',
    'React view removes the seeded subscription and derived-state anti-patterns',
    reactProblems.length === 0,
    reactProblems.length === 0 ? undefined : reactProblems.join('; '),
  )

  const verificationDocument = await readBoundedText(join(workspace, 'docs', 'verification.md'))
  const normalizedDocument = verificationDocument?.toLowerCase() ?? ''
  const documentationProblems = [
    ...(normalizedDocument.includes('root cause') ? [] : ['root cause']),
    ...(normalizedDocument.includes('systematic-debugging') ? [] : ['systematic-debugging']),
    ...(normalizedDocument.includes('vercel-react-best-practices') ? [] : ['vercel-react-best-practices']),
    ...(normalizedDocument.includes('playwright') ? [] : ['playwright']),
    ...(normalizedDocument.includes('npm test') ? [] : ['npm test']),
    ...(normalizedDocument.includes('npm run build') ? [] : ['npm run build']),
    ...(normalizedDocument.includes('npm run e2e') ? [] : ['npm run e2e']),
    ...(hasObservedZeroExitCode(verificationDocument ?? '') ? [] : ['observed exit code']),
  ]
  check(
    'verification-document',
    'verification.md records root causes, skill use, and observed release-gate evidence',
    documentationProblems.length === 0,
    documentationProblems.length === 0 ? undefined : `missing=${documentationProblems.join(',')}`,
  )

  const playwrightConfig = await firstExistingFile(workspace, [
    'playwright.config.ts', 'playwright.config.mts', 'playwright.config.js', 'playwright.config.mjs',
  ])
  const e2eFiles = await findE2eSpecs(workspace)
  check(
    'playwright-artifacts',
    'Playwright configuration and at least one E2E spec were added',
    playwrightConfig !== undefined && e2eFiles.length > 0,
    `config=${playwrightConfig ?? 'none'}; specs=${e2eFiles.join(',') || 'none'}`,
  )

  const playwrightConfigText = playwrightConfig === undefined
    ? undefined : await readBoundedText(join(workspace, playwrightConfig))
  const playwrightConfigSource = stripJavaScriptComments(playwrightConfigText ?? '')
  const configProblems = [
    ...(/\bbaseURL\s*:/.test(playwrightConfigSource) ? [] : ['baseURL']),
    ...(/\bwebServer\s*:/.test(playwrightConfigSource) ? [] : ['webServer']),
    ...(/\bcommand\s*:/.test(playwrightConfigSource) ? [] : ['webServer.command']),
    ...(/\burl\s*:/.test(playwrightConfigSource) ? [] : ['webServer.url']),
  ]
  check(
    'playwright-config',
    'Playwright config owns a baseURL-backed development web server',
    playwrightConfig !== undefined && configProblems.length === 0,
    configProblems.length === 0 ? undefined : `missing=${configProblems.join(',')}`,
  )

  const e2eUnits = (await Promise.all(e2eFiles.map(async path => ({
    path, text: await readBoundedText(join(workspace, ...path.split('/'))),
  })))).filter((unit): unit is { readonly path: string; readonly text: string } => unit.text !== undefined)
  const e2eText = e2eUnits.map(unit => unit.text).join('\n')
  const e2eSource = stripJavaScriptComments(e2eText)
  const e2eBehavior = extractReachablePlaywrightBehavior(e2eUnits)
  const e2eBehaviorSource = stripJavaScriptComments(e2eBehavior.source)
  const coverage = {
    testBody: e2eBehavior.testCount > 0,
    navigation: /\bpage\.goto\s*\(/.test(e2eBehaviorSource),
    semanticLocators: /\bpage\.(?:getByRole|getByLabel|getByPlaceholder)\s*\(/.test(e2eBehaviorSource),
    titleInput: /What happened/i.test(e2eBehaviorSource) && /\.fill\s*\(/.test(e2eBehaviorSource),
    criticalSeverity: /critical/i.test(e2eBehaviorSource) && /\.selectOption\s*\(/.test(e2eBehaviorSource),
    createClick: /Add to desk/i.test(e2eBehaviorSource) && /\.click\s*\(/.test(e2eBehaviorSource),
    filter: /Filter signals/i.test(e2eBehaviorSource) && /\.fill\s*\(/.test(e2eBehaviorSource),
    status: /Status for|investigating/i.test(e2eBehaviorSource) && /\.selectOption\s*\(/.test(e2eBehaviorSource),
    reload: /\bpage\.reload\s*\(/.test(e2eBehaviorSource),
    visibleAssertion: /\bexpect\s*\([\s\S]{0,240}\)\s*\.\s*(?:toBeVisible|toHaveText|toContainText)\s*\(/.test(e2eBehaviorSource),
    statusAssertion: /\bexpect\s*\([\s\S]{0,240}\)\s*\.\s*toHaveValue\s*\(\s*['"]investigating['"]/.test(e2eBehaviorSource),
  }
  const missingCoverage = Object.entries(coverage).filter(([, present]) => !present).map(([name]) => name)
  check(
    'e2e-scenario',
    'E2E spec exercises create, filter, status, and persistence after reload',
    missingCoverage.length === 0,
    missingCoverage.length === 0 ? undefined : `missing=${missingCoverage.join(',')}`,
  )
  const forbiddenE2ePatterns = [
    ...(/\bwaitForTimeout\s*\(/.test(e2eSource) ? ['waitForTimeout'] : []),
    ...(/\btest\s*\.\s*(?:skip|fixme|fail|only)\s*\(|\btest\.describe\.(?:skip|only|serial)\s*\(/.test(e2eSource) ? ['test.skip'] : []),
    ...(/\b(?:page\.)?locator\s*\(/.test(e2eSource) ? ['CSS/XPath locator API'] : []),
    ...(/\b(?:page\.)?\$\$?\s*\(/.test(e2eSource) ? ['CSS selector API'] : []),
    ...(/\bif\s*\(\s*(?:false|0)\s*\)/.test(e2eSource) ? ['unreachable test branch'] : []),
  ]
  check(
    'e2e-quality',
    'E2E spec avoids sleeps, disabled/serial tests, and CSS/XPath locators',
    e2eFiles.length > 0 && forbiddenE2ePatterns.length === 0,
    forbiddenE2ePatterns.length === 0 ? (e2eFiles.length > 0 ? undefined : 'no E2E spec') : `forbidden=${forbiddenE2ePatterns.join(',')}`,
  )
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function stripJavaScriptComments(value: string): string {
  type Mode = 'code' | 'single' | 'double' | 'template' | 'line' | 'block'
  let mode: Mode = 'code'
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index] ?? ''
    const next = value[index + 1] ?? ''
    if (mode === 'line') { if (current === '\n') { mode = 'code'; output += '\n' }; continue }
    if (mode === 'block') {
      if (current === '*' && next === '/') { mode = 'code'; output += ' '; index += 1 }
      else if (current === '\n') output += '\n'
      continue
    }
    if (mode === 'code') {
      if (current === '/' && next === '/') { mode = 'line'; index += 1; continue }
      if (current === '/' && next === '*') { mode = 'block'; index += 1; continue }
      if (current === "'") mode = 'single'; else if (current === '"') mode = 'double'; else if (current === '`') mode = 'template'
      output += current; continue
    }
    output += current
    if (current === '\\') { output += next; index += 1; continue }
    if ((mode === 'single' && current === "'") || (mode === 'double' && current === '"') || (mode === 'template' && current === '`')) mode = 'code'
  }
  return output
}

function extractReachablePlaywrightBehavior(units: readonly { readonly path: string; readonly text: string }[]): { readonly testCount: number; readonly source: string } {
  const sources = units.map(unit => stripJavaScriptComments(unit.text))
  const bodies = sources.flatMap(source => extractInlineCallbackBodies(source, /\btest\s*\(/g))
  const beforeEachBodies = sources.flatMap(source => extractInlineCallbackBodies(source, /\btest\s*\.\s*beforeEach\s*\(/g))
  return Object.freeze({ testCount: bodies.length, source: [...beforeEachBodies, ...bodies].join('\n') })
}

function extractInlineCallbackBodies(source: string, pattern: RegExp): readonly string[] {
  const output: string[] = []
  while (pattern.exec(source) !== null) {
    const arrow = findOutsideStrings(source, '=>', pattern.lastIndex)
    if (arrow < 0) break
    let bodyStart = arrow + 2
    while (/\s/.test(source[bodyStart] ?? '')) bodyStart += 1
    if (source[bodyStart] !== '{') { pattern.lastIndex = bodyStart; continue }
    const bodyEnd = findBalancedBrace(source, bodyStart)
    if (bodyEnd < 0) break
    output.push(source.slice(bodyStart + 1, bodyEnd)); pattern.lastIndex = bodyEnd + 1
  }
  return output
}

function hasObservedZeroExitCode(value: string): boolean {
  if (/exit\s*(?:code)?\s*[:=]?\s*0/i.test(value)) return true
  const lines = value.split(/\r?\n/)
  for (let index = 0; index < lines.length - 2; index += 1) {
    const header = markdownTableCells(lines[index] ?? '')
    const delimiter = markdownTableCells(lines[index + 1] ?? '')
    if (header.length === 0 || delimiter.length !== header.length || !delimiter.every(cell => /^:?-{3,}:?$/.test(cell))) continue
    const exitCodeColumn = header.findIndex(cell => /\bexit\s*code\b/i.test(stripMarkdownDecoration(cell)))
    if (exitCodeColumn < 0) continue
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = markdownTableCells(lines[rowIndex] ?? '')
      if (row.length !== header.length) break
      if (stripMarkdownDecoration(row[exitCodeColumn] ?? '') === '0') return true
    }
  }
  return false
}

function markdownTableCells(line: string): readonly string[] {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return []
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

function stripMarkdownDecoration(value: string): string { return value.replace(/[*_`]/g, '').trim() }

function findOutsideStrings(source: string, needle: string, start: number): number {
  let quote: "'" | '"' | '`' | undefined
  for (let index = start; index <= source.length - needle.length; index += 1) {
    const current = source[index]
    if (quote !== undefined) { if (current === '\\') index += 1; else if (current === quote) quote = undefined; continue }
    if (current === "'" || current === '"' || current === '`') { quote = current; continue }
    if (source.startsWith(needle, index)) return index
  }
  return -1
}
function findBalancedBrace(source: string, start: number): number {
  let depth = 0
  let quote: "'" | '"' | '`' | undefined
  for (let index = start; index < source.length; index += 1) {
    const current = source[index]
    if (quote !== undefined) { if (current === '\\') index += 1; else if (current === quote) quote = undefined; continue }
    if (current === "'" || current === '"' || current === '`') { quote = current; continue }
    if (current === '{') depth += 1
    else if (current === '}' && --depth === 0) return index
  }
  return -1
}
