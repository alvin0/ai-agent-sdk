/** SP-01 research: an `execute_program` tool that runs a QuickJS guest through the
 * scheduler-granted nested port. Not a package; no dependency is added to the workspace. */
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineTool, experimentalNestedToolPort, ToolError } from '@alvin0/ai-agent-sdk-core/agent'
import type { ToolDefinition } from '@alvin0/ai-agent-sdk-core/agent'
import type { JsonValue } from '@alvin0/ai-agent-sdk-core/tools'

/** Pinned research dependency, installed outside the workspace graph (see spike closeout). Resolved from the workspace root. */
export const QUICKJS_ENTRY = resolve('artifacts/spikes/quickjs-dependencies-v1/node_modules/quickjs-emscripten/dist/index.mjs')

export interface ProgramExecutorLimits {
  /** Guest CPU allowance enforced by the QuickJS interrupt handler. */
  readonly cpuMs: number
  /** Wall-clock allowance for the whole program, including child tool calls. */
  readonly wallMs: number
  /** QuickJS heap limit. Not a total process RSS limit. */
  readonly heapBytes: number
  /** V8 old-generation cap for the worker thread hosting the WASM guest. */
  readonly workerHeapMb: number
  readonly maxSourceBytes: number
  readonly maxReplyBytes: number
  readonly maxProjectionBytes: number
}

export const DEFAULT_PROGRAM_LIMITS: ProgramExecutorLimits = Object.freeze({
  cpuMs: 2_000, wallMs: 20_000, heapBytes: 8 * 1024 * 1024, workerHeapMb: 64,
  maxSourceBytes: 32 * 1024, maxReplyBytes: 256 * 1024, maxProjectionBytes: 16 * 1024,
})

export interface ProgramToolObserver {
  workerStarted?(): void
  workerExited?(): void
}

export function createProgramTool(options: {
  readonly name?: string
  readonly limits?: Partial<ProgramExecutorLimits>
  readonly quickjsEntry?: string
  readonly observer?: ProgramToolObserver
} = {}): ToolDefinition {
  const limits = Object.freeze({ ...DEFAULT_PROGRAM_LIMITS, ...options.limits })
  const quickjsEntry = options.quickjsEntry ?? QUICKJS_ENTRY
  return defineTool({
    name: options.name ?? 'execute_program',
    description: 'Run a short synchronous JavaScript function body that calls tools and returns JSON. '
      + 'callTool(name, args) returns the tool\'s value directly (no await; async code is rejected) and throws on failure. '
      + 'End with `return <json>`; only that result comes back to you. TOOLS lists the tools it may call with their parameters and output schema. '
      + 'callToolResult(name, args, { retain: true }) also returns a handle; loadResult(handle) reads it back in a later program this turn. '
      + 'Use it to page, filter, join or aggregate many tool results before answering.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Body of a synchronous JavaScript function; end with return.' } },
      required: ['code'],
      additionalProperties: false,
    },
    parse(raw: unknown) {
      const code = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'code') : undefined
      if (typeof code !== 'string' || Buffer.byteLength(code) > limits.maxSourceBytes) {
        throw new Error(`code must be a string of at most ${String(limits.maxSourceBytes)} bytes`)
      }
      return { code }
    },
    async execute(args: { code: string }, context) {
      const port = experimentalNestedToolPort(context)
      if (port === undefined) throw ToolError.respondToModel('program execution is not enabled for this session', 'PROGRAM_NOT_GRANTED')
      // Fail closed: no executor means no program, never host-side evaluation.
      if (!existsSync(quickjsEntry)) throw ToolError.respondToModel('the program executor is not installed', 'EXECUTOR_UNAVAILABLE')
      const worker = new Worker(new URL('./ptc-program-worker.mjs', import.meta.url), {
        workerData: { code: args.code, limits, quickjsEntry, catalog: port.catalog() },
        env: {}, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: limits.workerHeapMb, maxYoungGenerationSizeMb: 16 },
      })
      options.observer?.workerStarted?.()
      let settled = false
      const exited = new Promise<void>(resolve => worker.once('exit', () => { options.observer?.workerExited?.(); resolve() }))
      try {
        return await new Promise<{ result: JsonValue }>((settle, reject) => {
          const finish = (outcome: () => void) => { if (!settled) { settled = true; outcome() } }
          const fail = (code: string, message: string) => finish(() => reject(ToolError.respondToModel(message, code)))
          const timer = setTimeout(() => fail('PROGRAM_DEADLINE', `the program exceeded ${String(limits.wallMs)}ms`), limits.wallMs)
          const abort = () => fail('TOOL_ABORTED', 'the program was cancelled')
          if (context.signal.aborted) abort()
          context.signal.addEventListener('abort', abort, { once: true })
          const cleanup = () => { clearTimeout(timer); context.signal.removeEventListener('abort', abort) }
          worker.on('message', (message: { type: string; id?: number; tool?: string; args?: never; retain?: boolean; handle?: string; value?: unknown; code?: string; message?: string }) => {
            if (settled) return
            if (message.type === 'call' && message.id !== undefined) {
              const id = message.id
              void port.call(String(message.tool), message.args ?? {}, { retain: message.retain === true }).then(result => {
                if (settled) return
                worker.postMessage(result.ok
                  ? { id, ok: true, body: { value: result.value, schema: result.schema,
                    ...result.handle === undefined ? {} : { handle: result.handle },
                    ...result.retainRefused === undefined ? {} : { retainRefused: result.retainRefused } } }
                  : { id, ok: false, code: result.code, message: result.message })
              }, () => { if (!settled) worker.postMessage({ id, ok: false, code: 'PROGRAM_CLOSED', message: 'the host refused the call' }) })
              return
            }
            if (message.type === 'load' && message.id !== undefined) {
              const loaded = port.load(String(message.handle))
              worker.postMessage(loaded.ok
                ? { id: message.id, ok: true, body: { value: loaded.value, schema: loaded.schema, provenance: loaded.provenance } }
                : { id: message.id, ok: false, code: loaded.code, message: loaded.message })
              return
            }
            if (message.type === 'result') { cleanup(); finish(() => settle({ result: message.value as JsonValue })); return }
            if (message.type === 'error') { cleanup(); fail(String(message.code), String(message.message)) }
          })
          worker.once('error', error => { cleanup(); fail('EXECUTOR_FAILED', error instanceof Error ? error.message.slice(0, 256) : 'executor failed') })
          worker.once('exit', code => { cleanup(); fail('EXECUTOR_EXITED', `the executor exited with code ${String(code)}`) })
        })
      } finally {
        settled = true
        await worker.terminate()
        await exited
      }
    },
  })
}
