/**
 * SPIKE B  Ehow many steps does real multi-tool work actually take?
 *
 * Settles open decision #2 in `docs/tool-loop-design.md`. Neither reference
 * implementation has a step cap, so there is no prior art to copy and no way to
 * pick the number by reasoning. This measures it instead: run real exploration
 * tasks against a real model with real tools, and look at the distribution.
 *
 * The loop here is DELIBERATELY minimal and throwaway  Eno bounds, no events, no
 * repeat detection. Its only job is to count. Everything it lacks is what the real
 * implementation adds, and running it also proves the tool layer works end to end.
 *
 * Run: `node spikes/step-budget.ts` (needs `npm run provider:codex:login-device`).
 * Exact wire requests are appended to `.providers/codex/logs/YYYY-MM-DD.jsonl`.
 */

import { resolve, relative, sep } from 'node:path'
import { readFile as fsReadFile, readdir, stat } from 'node:fs/promises'
import { createTextMessage, createToolResultMessage } from '@ai-agent-sdk/core'
import type { Message } from '@ai-agent-sdk/core'
import { ModelRegistry } from '@ai-agent-sdk/core'
import { BlockAssembler } from '@ai-agent-sdk/core'
import { ToolCallId } from '@ai-agent-sdk/core'
import { codexAdapter } from '../src/providers/codex/adapter.ts'
import { createDailyJsonlRequestLogger } from '../src/providers/request-logger.ts'
import { dispatchToolCall } from '@ai-agent-sdk/agent'
import { ToolRegistry } from '@ai-agent-sdk/agent'
import { ToolError } from '@ai-agent-sdk/agent'
import { defineTool } from '@ai-agent-sdk/agent'

const MODEL = 'gpt-5.4'
const PROVIDER = 'codex'
/** Only to stop a runaway from spending real money; not a proposed default. */
const HARD_CAP = 40

const ROOT = resolve(import.meta.dirname, '..')
/** Skipped so the model cannot burn the budget reading dependencies. */
const EXCLUDED = ['node_modules', '.git', '.temp', 'dist', '.providers']

/** Confine every path to the repo. A spike still runs on a real machine. */
function safePath(input: string): string {
  const target = resolve(ROOT, input)
  const rel = relative(ROOT, target)
  if (rel.startsWith('..') || resolve(target) !== target && rel === '') {
    throw ToolError.respondToModel(`path escapes the repository: ${input}`, 'EACCES')
  }
  if (EXCLUDED.some(part => rel.split(sep).includes(part))) {
    throw ToolError.respondToModel(`path is excluded from this sandbox: ${input}`, 'EACCES')
  }
  return target
}

const listDir = defineTool({
  name: 'list_dir',
  description: 'List the entries of a directory in the repository. Use "." for the root.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Repo-relative directory path.' } },
    required: ['path'],
  },
  parse: (raw): { path: string } => {
    const value = raw as { path?: unknown }
    if (typeof value.path !== 'string') throw new Error('path must be a string')
    return { path: value.path }
  },
  isConcurrencySafe: () => true,
  execute: async ({ path }) => {
    const entries = await readdir(safePath(path), { withFileTypes: true })
    return entries
      .filter(entry => !EXCLUDED.includes(entry.name))
      .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
  },
})

const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read a UTF-8 text file from the repository.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Repo-relative file path.' } },
    required: ['path'],
  },
  parse: (raw): { path: string } => {
    const value = raw as { path?: unknown }
    if (typeof value.path !== 'string') throw new Error('path must be a string')
    return { path: value.path }
  },
  isConcurrencySafe: () => true,
  timeoutMs: 10_000,
  execute: async ({ path }) => {
    const target = safePath(path)
    const info = await stat(target)
    if (info.size > 200_000) {
      throw ToolError.respondToModel(`${path} is ${info.size} bytes, too large to read whole`, 'E2BIG')
    }
    return await fsReadFile(target, 'utf8')
  },
})

const grep = defineTool({
  name: 'grep',
  description: 'Search the repository for a regular expression. Returns matching lines with their file and line number.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression.' },
      glob: { type: 'string', description: 'Optional file-extension filter such as ".ts" or ".md".' },
    },
    required: ['pattern'],
  },
  parse: (raw): { pattern: string; glob?: string } => {
    const value = raw as { pattern?: unknown; glob?: unknown }
    if (typeof value.pattern !== 'string') throw new Error('pattern must be a string')
    return {
      pattern: value.pattern,
      ...typeof value.glob === 'string' ? { glob: value.glob } : {},
    }
  },
  isConcurrencySafe: () => true,
  timeoutMs: 20_000,
  execute: async ({ pattern, glob }) => {
    let regex: RegExp
    try {
      regex = new RegExp(pattern, 'u')
    } catch (error: unknown) {
      throw ToolError.respondToModel(
        `not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        'EINVAL',
      )
    }
    const hits: string[] = []
    const walk = async (dir: string): Promise<void> => {
      if (hits.length >= 60) return
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (EXCLUDED.includes(entry.name)) continue
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (glob !== undefined && !entry.name.endsWith(glob)) continue
        let text: string
        try {
          text = await fsReadFile(full, 'utf8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && hits.length < 60; i++) {
          if (regex.test(lines[i] ?? '')) {
            hits.push(`${relative(ROOT, full)}:${i + 1}: ${(lines[i] ?? '').trim().slice(0, 160)}`)
          }
        }
      }
    }
    await walk(ROOT)
    return hits.length === 0 ? 'no matches' : hits
  },
})

const SYSTEM = [
  'You are exploring a TypeScript repository to answer a question.',
  'Use the tools to find evidence. Do not guess at file contents.',
  'When you have the answer, reply with it directly and stop calling tools.',
  'Be concise: a few sentences.',
].join(' ')

/** Tasks that genuinely need several rounds of look-then-read. */
const TASKS: readonly { name: string; prompt: string }[] = [
  {
    name: 'trivial',
    prompt: 'What is the "name" field in package.json?',
  },
  {
    name: 'one-hop',
    prompt: 'Which file defines the SSE parser, and why does it not use TextDecoderStream? Quote the stated reason.',
  },
  {
    name: 'survey',
    prompt: 'How many provider folders exist under src/providers, and which wire protocol does each one speak?',
  },
  {
    name: 'cross-reference',
    prompt: 'Where is the default retry policy defined, and which error codes are retryable by default? Explain why AUTH is excluded.',
  },
  {
    name: 'contract',
    prompt: 'List the abstract members a provider adapter must implement, name the file they are declared in, and say which method is deliberately NOT an extension point.',
  },
  {
    name: 'open-ended',
    prompt: 'Find every place in src/ that mentions prompt caching and summarize why it matters to this codebase.',
  },
]

interface Measurement {
  task: string
  steps: number
  toolCalls: number
  toolErrors: number
  /** Recorded so a failure can be checked as recoverable rather than a pipeline bug. */
  errors: string[]
  finished: boolean
  inputTokens: number
  outputTokens: number
  answer: string
}

async function runTask(
  models: ModelRegistry,
  tools: ToolRegistry,
  task: { name: string; prompt: string },
): Promise<Measurement> {
  const messages: Message[] = [createTextMessage(task.prompt)]
  let toolCalls = 0
  let toolErrors = 0
  const errors: string[] = []
  let inputTokens = 0
  let outputTokens = 0
  let answer = ''

  for (let step = 1; step <= HARD_CAP; step++) {
    const assembler = new BlockAssembler()
    for await (const chunk of models.stream({
      provider: PROVIDER,
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: tools.schemas(),
    })) {
      assembler.push(chunk)
    }

    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      return {
        task: task.name,
        steps: step,
        toolCalls,
        toolErrors,
        errors,
        finished: false,
        inputTokens,
        outputTokens,
        answer: `<${finish.kind}: ${finish.failure.code} ${finish.failure.message}>`,
      }
    }

    inputTokens += assembler.usage?.inputTokens ?? 0
    outputTokens += assembler.usage?.outputTokens ?? 0

    const message = assembler.message({ kind: 'model', provider: PROVIDER, model: MODEL })
    messages.push(message)

    const calls = assembler.blocks().filter(block => block.type === 'tool-call')
    if (calls.length === 0) {
      answer = assembler.blocks()
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim()
      return {
        task: task.name,
        steps: step,
        toolCalls,
        toolErrors,
        errors,
        finished: true,
        inputTokens,
        outputTokens,
        answer,
      }
    }

    for (const call of calls) {
      if (call.type !== 'tool-call') continue
      const result = await dispatchToolCall({
        catalog: tools,
        call: {
          callId: call.id,
          toolName: call.name,
          rawArguments: call.arguments,
        },
        position: { turn: 1, step },
        signal: AbortSignal.timeout(60_000),
      })
      toolCalls += 1
      if (result.isError) {
        toolErrors += 1
        errors.push(
          `${call.name}(${call.arguments.slice(0, 70)})`
          + ` -> ${result.error.code}: ${result.error.message.slice(0, 110)}`,
        )
      }
      messages.push(createToolResultMessage({
        callId: ToolCallId(call.id),
        content: result.content,
        isError: result.isError,
      }))
    }
  }

  return {
    task: task.name,
    steps: HARD_CAP,
    toolCalls,
    toolErrors,
    errors,
    finished: false,
    inputTokens,
    outputTokens,
    answer: `<hit the ${HARD_CAP}-step hard cap>`,
  }
}

const models = new ModelRegistry()
models.registerAdapter([PROVIDER], codexAdapter({
  requestLogger: createDailyJsonlRequestLogger({ content: 'full', allowWireBodies: true }),
}))
const tools = new ToolRegistry()
tools.registerAll([listDir, readFileTool, grep] as never)

console.log(`\nSPIKE B  Estep budget (model ${MODEL}, hard cap ${HARD_CAP})\n`)

const results: Measurement[] = []
const only = process.argv[2]
for (const task of TASKS.filter(t => only === undefined || t.name === only)) {
  process.stdout.write(`  ${task.name.padEnd(16)} `)
  try {
    const measurement = await runTask(models, tools, task)
    results.push(measurement)
    process.stdout.write(
      `${String(measurement.steps).padStart(2)} steps  `
      + `${String(measurement.toolCalls).padStart(2)} calls  `
      + `${measurement.toolErrors} errors  `
      + `${measurement.finished ? 'ok' : 'UNFINISHED'}\n`,
    )
  } catch (error: unknown) {
    process.stdout.write(`THREW: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const finished = results.filter(r => r.finished)
const steps = finished.map(r => r.steps).sort((a, b) => a - b)
const percentile = (p: number): number =>
  steps.length === 0 ? 0 : steps[Math.min(steps.length - 1, Math.ceil((p / 100) * steps.length) - 1)] ?? 0

console.log('\n  distribution of steps for tasks that finished')
console.log(`    n=${steps.length}  min=${steps[0] ?? 0}  median=${percentile(50)}`
  + `  p90=${percentile(90)}  max=${steps.at(-1) ?? 0}`)
console.log(`    tool calls total: ${results.reduce((sum, r) => sum + r.toolCalls, 0)}`
  + `  tool errors: ${results.reduce((sum, r) => sum + r.toolErrors, 0)}`)
console.log(`    tokens: ${results.reduce((sum, r) => sum + r.inputTokens, 0)} in, `
  + `${results.reduce((sum, r) => sum + r.outputTokens, 0)} out\n`)

for (const r of results) {
  // Printed so a tool failure can be checked as a recoverable model mistake rather
  // than a bug in the dispatch pipeline.
  for (const e of r.errors) console.log(`    ! ${e}`)
  console.log(`  ${r.task} (${r.steps} steps): ${r.answer.slice(0, 220).replace(/\s+/g, ' ')}\n`)
}
