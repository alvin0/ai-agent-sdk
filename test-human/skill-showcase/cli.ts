#!/usr/bin/env node
import { resolve } from 'node:path'
import { stdout } from 'node:process'
import type { AgentRunEvent } from '@ai-agent-sdk/core/agent'
import type { HumanProvider } from '../config.ts'
import { HumanArtifactRecorder } from '../artifacts.ts'
import { errorMessage, label, paint } from '../console.ts'
import { summarizeToolArguments, summarizeToolResult } from '../terminal.ts'
import {
  EXTERNAL_SKILL_ID,
  relativeShowcasePath,
  runSkillShowcase,
} from './runner.ts'

interface CliOptions {
  readonly help: boolean
  readonly dryRun: boolean
  readonly runId?: string
  readonly workspace?: string
  readonly provider: HumanProvider
  readonly model?: string
  readonly effort: string
  readonly maxTurns: number
  readonly logs: boolean
}

async function main(): Promise<void> {
  let options: CliOptions
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error: unknown) {
    console.error(paint(31, errorMessage(error)))
    console.error('\n' + help())
    process.exitCode = 2
    return
  }
  if (options.help) { console.log(help()); return }
  const printable = {
    source: 'https://skills.sh/anthropics/skills/frontend-design',
    skillId: EXTERNAL_SKILL_ID,
    provider: options.provider,
    model: options.model ?? (options.provider === 'codex' ? 'gpt-5.6-luna' : 'required'),
    effort: options.effort,
    maxTurns: options.maxTurns,
    workspace: options.workspace ?? '<new isolated run directory>',
    requestLogs: options.logs,
  }
  console.log(label('showcase/config'), JSON.stringify(printable, null, 2))
  const artifact = new HumanArtifactRecorder({
    harness: 'skill-showcase-cli', resultsRoot: resolve('test-human/results/skill-showcase-cli'),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  })
  artifact.record('config', printable)
  if (options.dryRun) {
    const summary = await artifact.finish({ status: 'dry-run', config: printable })
    console.log(label('showcase/artifact'), summary.artifact.directory)
    return
  }

  console.log(label('showcase'), 'A live model will build a real website from a pinned third-party SKILL')
  console.log(label('proof'), 'the upstream body must reach model context before the first workspace write')
  const renderer = createEventRenderer()
  try {
    const result = await runSkillShowcase({
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      provider: options.provider,
      ...(options.model === undefined ? {} : { model: options.model }),
      effort: options.effort,
      maxTurns: options.maxTurns,
      logs: options.logs,
      onProgress: message => console.log(label('skills.sh'), message),
      onEvent: renderer.render,
    })
    renderer.flush()
    const color = result.passed ? 32 : 31
    console.log('\n' + label('verification'), paint(color, result.passed ? 'PASSED' : 'FAILED'))
    for (const check of result.checks) {
      console.log(`  ${check.passed ? paint(32, '✓') : paint(31, '✗')} ${check.name}${check.passed || check.detail === undefined ? '' : ` — ${check.detail}`}`)
    }
    console.log('\n' + label('external/source'), JSON.stringify(result.source, null, 2))
    console.log(label('skill → tool → artifact'), result.toolSequence.join(' → '))
    console.log(label('website'), relativeShowcasePath(result.workspace))
    console.log(label('report'), relativeShowcasePath(result.report))
    console.log(label('repair-turns'), String(result.repairTurns))
    console.log(label('preview'), `cd "${result.workspace}"; npm start`)
    const summary = await artifact.finish({
      status: result.passed ? 'passed' : 'failed', config: printable,
      invariants: result.checks, metrics: {
        repairTurns: result.repairTurns, artifactFiles: result.artifactFiles.length,
        toolCalls: result.toolSequence.length, report: result.report,
      },
    })
    console.log(label('showcase/artifact'), summary.artifact.directory)
    if (!result.passed) process.exitCode = 1
  } catch (error: unknown) {
    renderer.flush()
    const summary = await artifact.finish({ status: 'failed', config: printable, error })
    console.error(label('showcase/artifact'), summary.artifact.directory)
    console.error('\n' + label('showcase/error'), paint(31, errorMessage(error)))
    process.exitCode = 1
  }
}

function createEventRenderer(): {
  readonly render: (event: AgentRunEvent) => void
  readonly flush: () => void
} {
  let active = false
  let activeBlock = ''
  const flush = (): void => {
    if (active) stdout.write('\n')
    active = false
    activeBlock = ''
  }
  const stream = (block: string, heading: string, text: string): void => {
    if (!active || block !== activeBlock) {
      flush()
      stdout.write(`${label(heading)} `)
      active = true
      activeBlock = block
    }
    stdout.write(text)
  }
  const render = (event: AgentRunEvent): void => {
    if (event.type === 'reasoning-delta') {
      stream(`reasoning:${event.index}`, 'agent/reasoning-summary', event.text)
      return
    }
    if (event.type === 'text-delta' && event.phase === 'commentary') {
      stream(`commentary:${event.index}`, 'agent/commentary', event.text)
      return
    }
    if (event.type === 'text-delta' && event.phase === 'final-answer') {
      stream(`final:${event.index}`, 'agent/final', event.text)
      return
    }
    flush()
    if (event.type === 'tool-call') {
    const group = event.call.toolName === 'load_skill' || event.call.toolName.includes('skill_resource')
      ? 'skill/tool' : 'workspace/tool'
    console.log(label(group), event.call.toolName, summarizeToolArguments(event.call.rawArguments))
    } else if (event.type === 'tool-result') {
      console.log(label('tool/result'), event.call.toolName, summarizeToolResult(event.result))
    } else if (event.type === 'compaction-end') {
      console.log(label('compact'), event.status, `saved=${event.estimatedTokensBefore - event.estimatedTokensAfter}`)
    }
  }
  return { render, flush }
}

function parseArgs(args: readonly string[]): CliOptions {
  let runId: string | undefined
  let workspace: string | undefined
  let provider: HumanProvider = 'codex'
  let model: string | undefined
  let effort = 'medium'
  let maxTurns = 24
  let helpRequested = false
  let dryRun = false
  let logs = true
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') helpRequested = true
    else if (argument === '--dry-run') dryRun = true
    else if (argument === '--no-logs') logs = false
    else if (argument === '--run-id') runId = requiredValue(args, ++index, argument)
    else if (argument === '--workspace') workspace = resolve(requiredValue(args, ++index, argument))
    else if (argument === '--provider') {
      const value = requiredValue(args, ++index, argument)
      if (value !== 'codex' && value !== 'openai' && value !== 'anthropic') {
        throw new Error('--provider must be codex, openai, or anthropic')
      }
      provider = value
    } else if (argument === '--model') model = requiredValue(args, ++index, argument)
    else if (argument === '--effort') effort = requiredValue(args, ++index, argument)
    else if (argument === '--max-turns') {
      maxTurns = Number(requiredValue(args, ++index, argument))
      if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('--max-turns must be a positive integer')
    } else throw new Error(`unknown argument: ${argument}`)
  }
  return {
    help: helpRequested, dryRun, provider, effort, maxTurns, logs,
    ...(runId === undefined ? {} : { runId }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(model === undefined ? {} : { model }),
  }
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function help(): string {
  return [
    'Live skills.sh website showcase',
    '',
    'Usage:',
    '  pnpm human:skill-showcase',
    '  pnpm human:skill-showcase -- --provider codex --model gpt-5.6-luna --effort medium',
    '',
    'Options:',
    '  --provider <codex|openai|anthropic>  Default: codex',
    '  --model <id>                         Codex default: gpt-5.6-luna',
    '  --effort <id>                        Default: medium',
    '  --max-turns <number>                 Default: 24',
    '  --workspace <path>                   Default: isolated timestamped directory',
    '  --run-id <id>                        Stable report/workspace suffix',
    '  --no-logs                            Disable provider request JSONL',
    '  --dry-run                            Print configuration without downloading or calling a model',
    '',
    'The command downloads a pinned, hash-verified frontend-design SKILL from Anthropic,',
    'then asks a real model to discover, activate, apply, build, test, and self-check a website.',
  ].join('\n')
}

await main()
