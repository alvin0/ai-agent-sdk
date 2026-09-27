import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseAnswer, gradeAnswer, type Grade } from './grading.ts'
import type { EvaluationCaseV2 } from './cohort-v2.ts'

export const PATCH_ORACLE_IMAGE = 'node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1'

/** Apply a standard unified diff to the single permitted fixture, with exact context. */
export function applyInvoicePatch(source: string, patch: string): string {
  if (patch.length > 16_384 || patch.includes('\0')) throw new Error('Invalid patch size')
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  const minus = lines.findIndex(line => line.startsWith('--- '))
  if (minus < 0 || !/^--- (?:a\/)?invoice\.mjs(?:\t.*)?$/.test(lines[minus]!)
    || !/^\+\+\+ (?:b\/)?invoice\.mjs(?:\t.*)?$/.test(lines[minus + 1] ?? '')) throw new Error('Unexpected patch target')
  const original = source.split('\n'); if (original.at(-1) === '') original.pop()
  const output: string[] = []
  let consumed = 0, at = minus + 2, hunks = 0
  while (at < lines.length) {
    if (at === lines.length - 1 && lines[at] === '') break
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(lines[at++]!)
    if (!header) throw new Error('Invalid hunk')
    const start = Number(header[1]) - 1, oldCount = Number(header[2] ?? 1), newStart = Number(header[3]) - 1, newCount = Number(header[4] ?? 1)
    if (start < consumed || start > original.length || oldCount < 0 || newCount < 0) throw new Error('Invalid hunk range')
    output.push(...original.slice(consumed, start)); consumed = start
    if (newStart !== output.length) throw new Error('Invalid new hunk range')
    let read = 0, written = 0
    while (at < lines.length && !lines[at]!.startsWith('@@ ')) {
      const line = lines[at]!
      if (at === lines.length - 1 && line === '') break
      at++
      if (line === '\\ No newline at end of file') continue
      const kind = line[0], content = line.slice(1)
      if (kind === ' ' || kind === '-') {
        if (original[consumed++] !== content) throw new Error('Patch context mismatch')
        read++
      }
      if (kind === ' ' || kind === '+') { output.push(content); written++ }
      if (kind !== ' ' && kind !== '-' && kind !== '+') throw new Error('Unsupported patch record')
    }
    if (read !== oldCount || written !== newCount) throw new Error('Hunk counts mismatch')
    hunks++
  }
  if (!hunks) throw new Error('No patch hunks')
  output.push(...original.slice(consumed))
  return output.join('\n') + '\n'
}

// The candidate process sees only source and input vectors, never expected values.
// No host workspace or credentials are mounted/passed; Docker is mandatory.
const BOOTSTRAP = `const fs=require('fs');let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',async()=>{const p=JSON.parse(text);fs.writeFileSync('/tmp/invoice.mjs',p.source);const m=await import('file:///tmp/invoice.mjs');const values=p.inputs.map(a=>m.total(...a));process.stdout.write(JSON.stringify(values));});`
export async function checkInvoiceBehavior(source: string): Promise<boolean> {
  const inputs = [[0, 0, 0], [2, 10, 0], [3, 7, .2], [0, 4, .5], [1, 9, 1], [5, 4, .25], [12, 199, .15], [1, .3, .1], [9, 0, .4], [0.5, 24, .125]]
  const expected = [0, 20, 16.8, 0, 0, 15, 2029.8, .27, 0, 10.5]
  const name = `sdk-patch-oracle-${crypto.randomUUID()}`
  try {
    const child = execFile('docker', ['run', '--pull', 'never', '--rm', '-i', '--name', name, '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--memory', '64m', '--pids-limit', '64', '--cpus', '0.5', '--tmpfs', '/tmp:rw,nosuid,noexec,size=1048576', PATCH_ORACLE_IMAGE, 'node', '-e', BOOTSTRAP],
      { timeout: 8000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
    const settled = new Promise<string>((resolve, reject) => {
      let stdout = ''
      child.stdout?.on('data', data => { stdout += String(data) })
      child.on('error', reject)
      child.on('close', code => { if (code === 0) resolve(stdout); else reject(new Error('Patch process failed')) })
    })
    child.stdin?.end(JSON.stringify({ source, inputs }))
    const values: unknown = JSON.parse(await settled)
    return Array.isArray(values) && values.length === expected.length && values.every((value, i) => typeof value === 'number' && Math.abs(value - expected[i]!) < 1e-8)
  } catch { return false } finally {
    try { await promisify(execFile)('docker', ['rm', '-f', name], { timeout: 5000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }) } catch { /* --rm already removed it */ }
  }
}

export async function gradeAnswerV2(test: EvaluationCaseV2, text: string, effects: number, observation: {
  readonly privateDataLeaked?: boolean
  readonly compactionSucceeded?: boolean
} = {}): Promise<Grade> {
  const grade = gradeAnswer(test, text, effects)
  if (test.patchSource !== undefined) {
    let correct = false
    try {
      const answer = parseAnswer(text)
      if (typeof answer.patch === 'string') correct = await checkInvoiceBehavior(applyInvoicePatch(test.patchSource, answer.patch))
    } catch { /* Invalid patches fail rather than executing on the host. */ }
    grade.checks.push({ name: 'real patch passes independent container behavioral tests', passed: correct })
  }
  if (test.privateContacts) grade.checks.push({ name: 'private contacts absent from model-visible data and events', passed: observation.privateDataLeaked === false })
  if (test.realCompaction) grade.checks.push({ name: 'real SDK compaction completed before revision recall', passed: observation.compactionSucceeded === true })
  if (test.reviewRubric) {
    const answer = (() => { try { return parseAnswer(text) } catch { return {} } })()
    const field = test.id === 'LANG-05' ? 'rewrite' : test.id === 'LANG-06' ? 'sentence' : 'summary'
    const content = answer[field]
    grade.checks.push({ name: 'reviewable prose present', passed: typeof content === 'string' && content.trim().length > 0 })
  }
  if (grade.checks.some(check => !check.passed)) return { ...grade, status: 'failed' }
  return { ...grade, status: test.reviewRubric ? 'needs-review' : 'passed' }
}
