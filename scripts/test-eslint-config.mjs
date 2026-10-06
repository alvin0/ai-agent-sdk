import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ESLint } from 'eslint'
import { spawnSync } from 'node:child_process'

const eslint = new ESLint()
const filePath = 'packages/decision-adapter/src/lint-probe.ts'

async function messages(source, path = filePath) {
  const [result] = await eslint.lintText(source, { filePath: path })
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages))
  return result.messages
}

async function expectRule(source, ruleId) {
  const found = await messages(source)
  assert.ok(found.some(message => message.ruleId === ruleId && message.severity === 2),
    `Expected ${ruleId} error: ${JSON.stringify(found)}`)
}

test('parses ordinary TS, TSX, MTS, CTS, JS, JSX and CommonJS files', async () => {
  const sources = [
    ['packages/decision-adapter/src/probe.ts', 'export const value: number = 1'],
    ['scripts/probe.mts', 'export const value: number = 1'],
    ['scripts/probe.cts', 'const value: number = 1; export = value'],
    ['samples/probe.tsx', 'export const view = <span>ok</span>'],
    ['web-documents/probe.jsx', 'export const view = <span>ok</span>'],
    ['scripts/probe.mjs', 'export const value = 1'],
    ['scripts/probe.js', 'export const value = 1'],
    ['scripts/probe.cjs', 'module.exports = { value: 1 }'],
  ]
  for (const [path, source] of sources) assert.deepEqual(await messages(source, path), [])
})

test('120 characters pass; 121 fail for code, comments and literals', async () => {
  const prefixes = ['// ', 'const value = "', 'const value = `', 'const value = /']
  const suffixes = ['', '"', '`', '/']
  for (const [index, prefix] of prefixes.entries()) {
    const suffix = suffixes[index]
    const line = prefix + 'x'.repeat(120 - prefix.length - suffix.length) + suffix
    assert.deepEqual(await messages(line), [])
    await expectRule(line.replace('x', 'xx'), '@stylistic/max-len')
  }
  await expectRule('// https://example.com/' + 'x'.repeat(120), '@stylistic/max-len')
})

test('file limit counts blank and comment-only lines', async () => {
  const source = 'export const value = 1\n' + '\n'.repeat(199) + '// comment\n'.repeat(200)
  assert.deepEqual(await messages(source), [])
  await expectRule(source + '\n', 'max-lines')
  await expectRule(source + '// extra\n', 'max-lines')
})

test('long functions fail even with low statement count', async () => {
  const body = Array.from({ length: 58 }, (_, index) => `    ${index},`).join('\n')
  const source = `function values() {\n  return [\n${body}\n  ]\n}`
  await expectRule(source, 'max-lines-per-function')
  await expectRule(`(${source.replace('function values', 'function')})()`, 'max-lines-per-function')
})

test('compressed functions fail the statement limit', async () => {
  const statements = Array.from({ length: 31 }, () => '  work()').join('\n')
  await expectRule(`function run() {\n${statements}\n}`, 'max-statements')
})

test('branch-heavy functions fail cyclomatic complexity', async () => {
  const branches = Array.from({ length: 10 }, (_, index) => `  if (value === ${index}) return ${index}`)
  await expectRule(`function classify(value) {\n${branches.join('\n')}\n}`, 'complexity')
})

test('simple ternaries pass but nested ternaries fail in either branch', async () => {
  assert.deepEqual(await messages('const value = ready ? yes : no'), [])
  await expectRule('const value = ready ? (valid ? yes : fallback) : no', 'no-nested-ternary')
  await expectRule('const value = ready ? yes : valid ? fallback : no', 'no-nested-ternary')
})

test('nested control flow fails cognitive complexity and block depth', async () => {
  const source = [
    'function run(value) {',
    '  if (value) {',
    '    for (const item of value) {',
    '      while (item.active) {',
    '        if (item.ready) {',
    '          for (const part of item.parts) {',
    '            if (part.ready) work(part)',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n')
  await expectRule(source, 'sonarjs/cognitive-complexity')
  await expectRule(source, 'max-depth')
})

test('callback nesting and parameter limits apply to tests too', async () => {
  const callbacks = 'run(() => run(() => run(() => run(() => work()))))'
  const found = await messages(callbacks, 'tests/unit/lint-probe.spec.ts')
  assert.ok(found.some(message => message.ruleId === 'max-nested-callbacks' && message.severity === 2))
  await expectRule('function run(a, b, c, d, e) { return a }', 'max-params')
  assert.deepEqual(await messages('function run(a, b, c, d) { return a }'), [])
})

test('ignores generated output and invalid fixtures but checks consumer fixtures', async () => {
  const ignoredPaths = [
    'packages/core/dist/index.js',
    'dist-cli/human.mjs',
    'artifacts/report.js',
    'samples/chat-agents/web/.next/server/page.js',
    'samples/chat-agents/web/.next-live/server/page.js',
    '.turbo/cache/probe.js',
    '.codegraph/probe.js',
    'web-documents/.vitepress/cache/probe.js',
    'test-human/workspaces/probe/index.ts',
    'tests/negative-fixtures/graph-cycle/index.ts',
  ]
  for (const path of ignoredPaths) assert.equal(await eslint.isPathIgnored(path), true, path)
  assert.equal(await eslint.isPathIgnored('packages/core/fixtures/browser/index.ts'), false)
})

test('handwritten code in hidden directories remains checked', async () => {
  const paths = ['.github/scripts/probe.mjs', '.config/probe.ts', 'web-documents/.vitepress/config.ts']
  for (const path of paths) {
    assert.equal(await eslint.isPathIgnored(path), false, path)
    const found = await messages('const value = ready ? yes : valid ? fallback : no', path)
    assert.ok(found.some(message => message.ruleId === 'no-nested-ternary' && message.severity === 2), path)
  }
})

test('output directory names and generated suffixes inside source remain checked', async () => {
  const paths = [
    'packages/core/src/build/logic.ts',
    'packages/core/src/artifacts/schema.ts',
    'packages/core/src/tasks.generated.ts',
    'packages/core/src/bundle.min.js',
    'packages/core/src/.next-live/logic.ts',
  ]
  for (const path of paths) {
    assert.equal(await eslint.isPathIgnored(path), false, path)
    const found = await messages('const value = ready ? yes : valid ? fallback : no', path)
    assert.ok(found.some(message => message.ruleId === 'no-nested-ternary'), path)
  }
})

test('comments cannot disable rules or increase their thresholds', async () => {
  const comments = ['/* eslint-disable */', '/* eslint max-lines: ["error", 999] */']
  for (const comment of comments) {
    const source = comment + '\n' + '// line\n'.repeat(401)
    const found = await messages(source)
    assert.ok(found.some(message => message.ruleId === 'max-lines' && message.severity === 2))
    assert.ok(found.some(message => /has no effect/.test(message.message)))
  }
  const found = await messages('// eslint-disable-next-line complexity\nexport const value = 1')
  assert.ok(found.some(message => /has no effect/.test(message.message)))
})

test('ignored directive warnings fail the CLI even without another violation', () => {
  const result = spawnSync(process.execPath, [
    'node_modules/eslint/bin/eslint.js', '--stdin', '--stdin-filename', filePath, '--max-warnings', '0',
  ], { encoding: 'utf8', input: '/* eslint-disable */\nexport const value = 1' })
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /has no effect/)
})

test('this annotations are excluded but a fifth real parameter still fails', async () => {
  const four = 'function run(this: object, a: number, b: number, c: number, d: number) {}'
  assert.deepEqual(await messages(four), [])
  await expectRule(four.replace('d: number)', 'd: number, e: number)'), 'max-params')
  await expectRule('declare function run(a: number, b: number, c: number, d: number, e: number): void',
    'max-params')
  await expectRule('type Run = (a: number, b: number, c: number, d: number, e: number) => void', 'max-params')
})

test('only framework suite registration callbacks are exempt from function length', async () => {
  const body = Array.from({ length: 20 }, () => "  it('case', () => {\n    work()\n  })").join('\n')
  const headers = [
    ['', 'describe'],
    ["import { describe } from 'vitest'", 'describe'],
    ["import { describe as group } from 'vitest'", 'group'],
    ["import { suite as group } from 'vitest'", 'group'],
    ["import * as framework from 'vitest'", 'framework.describe'],
    ["import { describe } from '@jest/globals'", 'describe'],
    ["import { describe } from 'node:test'", 'describe'],
    ["import { describe } from 'vitest'", 'describe.skipIf(false)'],
    ["import { describe } from 'vitest'", 'describe.each([1])'],
    ["import { describe } from 'vitest'", 'describe.each`value\n${1}`'],
  ]
  for (const [header, callee] of headers) {
    const source = `${header}\n${callee}('suite', () => {\n${body}\n})`
    assert.deepEqual(await messages(source, 'tests/unit/lint-probe.spec.ts'), [])
  }
})

test('long test cases, hooks, helpers and shadowed describe functions still fail', async () => {
  const body = '  return [\n' + '    1,\n'.repeat(59) + '  ]'
  const cases = [
    `it('case', () => {\n${body}\n})`,
    `beforeEach(() => {\n${body}\n})`,
    `function helper() {\n${body}\n}`,
    `function describe() {}\ndescribe('suite', () => {\n${body}\n})`,
    `import { describe } from './business.ts'\ndescribe('suite', () => {\n${body}\n})`,
    `describe('suite', () => {\nfunction helper() {\n${body}\n}\n})`,
  ]
  for (const source of cases) {
    const found = await messages(source, 'tests/unit/lint-probe.spec.ts')
    assert.ok(found.some(message => message.ruleId === 'workspace/max-lines-per-test-function'
      && message.severity === 2), source)
  }
  const source = `describe('suite', () => {\n${body}\n})`
  await expectRule(source, 'max-lines-per-function')
})

test('function length boundaries remain 60/61 for production and test helpers', async () => {
  const source = 'function helper() {\n  return [\n' + '    1,\n'.repeat(56) + '  ]\n}'
  for (const path of [filePath, 'tests/unit/lint-probe.spec.ts']) {
    assert.deepEqual(await messages(source, path), [])
    const found = await messages(source.replace('  ]', '    1,\n  ]'), path)
    assert.ok(found.some(message => /has too many lines \(61\)/.test(message.message)))
  }
})

test('lint runner executes later gates after failure and preserves the failure status', () => {
  const source = [
    "import { runNodeChecks } from './scripts/run-node-checks.mjs'",
    'process.exitCode = runNodeChecks([',
    "  ['fail', ['-e', 'process.exit(1)']],",
    "  ['after', ['-e', 'console.log(123456)']],",
    '])',
  ].join('\n')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /123456/)
  assert.match(result.stderr, /fail failed/)
})
