import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Job, Result, RunAttempt } from './execute.ts'
import { maxRunAttempts } from './reliability.ts'
import { checkCount, selectTasks } from './tasks.ts'

export type CellResult = Omit<Result, 'metrics'> & { metrics: Result['metrics'] | null }
export type RunJob = (job: Job) => Promise<{ result: Result; audit: unknown }>
export const cellId = (job: Pick<Job, 'task' | 'arm' | 'rep'>) => `${job.task}.${job.arm}.${job.rep}`
export const infraStatus = (status: string) => ['infra-failed', 'infrastructure-error'].includes(status)
async function readResult(path: string): Promise<CellResult | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as CellResult }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
async function atomicJson(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2))
  await rename(`${path}.tmp`, path)
}
function graded(result: CellResult | undefined): result is CellResult {
  return result !== undefined && !infraStatus(result.status) && !result.graderError
    && Array.isArray(result.checks) && Number.isFinite(result.score) && typeof result.pass === 'boolean'
}
function attemptSummary(result: CellResult, attempt: number, file: string): RunAttempt {
  return { attempt, status: result.status, file, metrics: result.metrics,
    ...(result.error ? { error: result.error } : {}) }
}
async function history(out: string, id: string, previous: CellResult | undefined) {
  const attempts = new Map((previous?.attempts ?? []).map(attempt => [attempt.attempt, attempt]))
  for (const file of await readdir(out)) {
    if (!file.startsWith(`${id}.attempt-`)) continue
    const match = /\.attempt-(\d+)\.json$/.exec(file)
    if (!match) continue
    const attempt = Number(match[1])
    if (!attempts.has(attempt)) {
      const result = (await readResult(join(out, file)))!
      attempts.set(attempt, attemptSummary(result, attempt, file))
    }
  }
  return [...attempts.values()].sort((a, b) => a.attempt - b.attempt)
}
async function attemptRun(job: Job, run: RunJob): Promise<{ result: CellResult; audit: unknown }> {
  try { return await run(job) }
  catch (error) {
    const task = selectTasks(job.suite, job.seed).find(task => task.id === job.task)!
    return { audit: null, result: { ...job, schemaVersion: 1, status: 'infra-failed', kind: task.kind,
      checks: Array.from({ length: checkCount(task) }, () => false),
      graderError: 'Child process unavailable; workspace grade unknown.',
      error: String(error), metrics: null, score: 0, pass: false, text: '', artifacts: {} } }
  }
}
export async function runCell(job: Job, out: string, run: RunJob, resume = false) {
  const id = cellId(job), path = join(out, `${id}.json`)
  const previous = await readResult(path) ?? await readResult(join(out, `${id}.fatal.json`))
  // A failed model/timeout/cap with a deterministic grade is also a finished cell.
  if (resume && graded(previous)) return { result: previous, skipped: true }
  const attempts = await history(out, id, previous)
  for (let retry = 0; retry < maxRunAttempts; retry++) {
    let { result, audit } = await attemptRun(job, run)
    const attempt = (attempts.at(-1)?.attempt ?? 0) + 1
    const file = `${id}.attempt-${attempt}.json`
    attempts.push(attemptSummary(result, attempt, file))
    // Save immutable attempts first; a crash before canonical publication cannot overwrite their evidence.
    await atomicJson(join(out, file), result)
    await atomicJson(join(out, `${id}.attempt-${attempt}.audit.json`), audit)
    result = { ...result, attempts: [...attempts] }
    await atomicJson(join(out, `${id}.audit.json`), audit)
    await atomicJson(path, result)
    await rm(join(out, `${id}.fatal.json`), { force: true })
    if (!infraStatus(result.status) || retry === maxRunAttempts - 1) return { result, skipped: false }
  }
  throw new Error('Unreachable attempt limit')
}
