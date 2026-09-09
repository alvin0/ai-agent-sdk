import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { stat } from 'node:fs/promises'
import type {
  SignalDeskCommandRequest,
  SignalDeskCommandResult,
} from './contracts.ts'

export async function runSignalDeskCommand(request: SignalDeskCommandRequest): Promise<SignalDeskCommandResult> {
  const started = Date.now()
  const executable = await resolveNpmExecutable()
  const command = executable.kind === 'node' ? process.execPath : executable.path
  const args = executable.kind === 'node' ? [executable.path, ...request.args] : [...request.args]
  return new Promise(resolvePromise => {
    const stdout = new BoundedCapture(request.maxOutputChars)
    const stderr = new BoundedCapture(request.maxOutputChars)
    let timedOut = false
    let aborted = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const child = spawn(command, args, {
      cwd: request.cwd, env: request.env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => stdout.append(chunk as string))
    child.stderr.on('data', chunk => stderr.append(chunk as string))
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      request.signal?.removeEventListener('abort', abortListener)
      resolvePromise(Object.freeze({
        name: request.name, command: request.command, args: Object.freeze([...request.args]),
        exitCode, signal, timedOut, aborted, durationMs: Math.max(0, Date.now() - started),
        stdout: stdout.value(), stderr: stderr.value(), stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
      }))
    }
    const abortListener = (): void => { aborted = true; terminateProcessTree(child.pid) }
    child.once('error', error => { stderr.append(errorMessage(error)); finish(null, null) })
    child.once('close', (code, signal) => finish(code, signal))
    timer = setTimeout(() => { timedOut = true; terminateProcessTree(child.pid) }, request.timeoutMs)
    timer.unref()
    if (request.signal?.aborted) abortListener()
    else request.signal?.addEventListener('abort', abortListener, { once: true })
  })
}

export function failedSignalDeskCommandResult(request: SignalDeskCommandRequest, error: unknown): SignalDeskCommandResult {
  return Object.freeze({
    name: request.name, command: request.command, args: Object.freeze([...request.args]), exitCode: null,
    signal: null, timedOut: false, aborted: request.signal?.aborted === true, durationMs: 0,
    stdout: '', stderr: errorMessage(error), stdoutTruncated: false, stderrTruncated: false,
  })
}

export function commandDetail(result: SignalDeskCommandResult): string {
  const tail = (result.stderr.trim() || result.stdout.trim()).slice(-1_000)
  return [`exit=${result.exitCode ?? 'spawn-error'}`, `durationMs=${result.durationMs}`,
    ...(result.timedOut ? ['timedOut=true'] : []), ...(result.aborted ? ['aborted=true'] : []),
    ...(tail.length === 0 ? [] : [`output=${tail}`])].join('; ')
}

export function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return selected
}

async function resolveNpmExecutable(): Promise<{ readonly kind: 'node'; readonly path: string } | { readonly kind: 'direct'; readonly path: string }> {
  const npmExecPath = process.env.npm_execpath
  const candidates = [...(npmExecPath === undefined ? [] : [npmExecPath]), join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => undefined)
    if (info?.isFile()) return Object.freeze({ kind: 'node', path: candidate })
  }
  return Object.freeze({ kind: 'direct', path: process.platform === 'win32' ? 'npm.cmd' : 'npm' })
}

function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
    killer.unref(); return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* exited */ } }
}

class BoundedCapture {
  readonly #headLimit: number
  readonly #tailLimit: number
  #head = ''
  #tail = ''
  #totalChars = 0
  constructor(private readonly limit: number) {
    this.#headLimit = Math.floor(limit / 2); this.#tailLimit = limit - this.#headLimit
  }
  get truncated(): boolean { return this.#totalChars > this.limit }
  append(chunk: string): void {
    this.#totalChars += chunk.length
    if (this.#head.length < this.#headLimit) {
      const needed = this.#headLimit - this.#head.length; this.#head += chunk.slice(0, needed); chunk = chunk.slice(needed)
    }
    if (chunk.length > 0) this.#tail = (this.#tail + chunk).slice(-this.#tailLimit)
  }
  value(): string {
    if (!this.truncated) return this.#head + this.#tail
    const omitted = Math.max(0, this.#totalChars - this.#head.length - this.#tail.length)
    return `${this.#head}\n... <${omitted} output chars omitted> ...\n${this.#tail}`
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
