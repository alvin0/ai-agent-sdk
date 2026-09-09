/** Command-line configuration for the long-running coding acceptance test. */

import { resolve } from 'node:path'
import {
  parseHumanCliArgs,
  resolveHumanModel,
  type HumanCliConfig,
} from '../config.ts'

export const DEFAULT_AGENTCODE_PROMPT =
  'tạo ra một ứng dụng todo reactjs có sử dụng zustand để quản lý state và sử dụng localstorage để quản lý database.'

export interface AgentCodeCliConfig extends HumanCliConfig {
  readonly workdir: string
  /** Optional prepared skills.sh roots, in discovery precedence order. */
  readonly skillRoots?: readonly string[]
  readonly maxInputTokens: number
  readonly retainTokens: number
  readonly maxToolCalls: number
  /** Exit after the initial run instead of keeping the conversation open. */
  readonly once: boolean
}

const SPECIAL_VALUE_FLAGS = new Set([
  '--workdir', '--skills-root', '--max-input-tokens', '--retain-tokens', '--max-tool-calls',
])

export function parseAgentCodeCliArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): AgentCodeCliConfig {
  const common: string[] = []
  const values = new Map<string, string>()
  const skillRoots: string[] = []
  let noReasoning = false
  let once = false

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    if (token === '--no-show-reasoning') {
      noReasoning = true
      continue
    }
    if (token === '--once') {
      once = true
      continue
    }
    const equals = token.indexOf('=')
    const key = equals > 0 ? token.slice(0, equals) : token
    if (!SPECIAL_VALUE_FLAGS.has(key)) {
      common.push(token)
      continue
    }
    const value = equals > 0 ? token.slice(equals + 1) : argv[++index]
    if (value === undefined || value.length === 0 || (equals < 0 && value.startsWith('--'))) {
      throw new Error(`${key} requires a value`)
    }
    if (key === '--skills-root') {
      skillRoots.push(resolve(cwd, value))
      continue
    }
    values.set(key, value)
  }

  if (!hasValueFlag(common, '--max-turns')) common.push('--max-turns', '32')
  const base = parseHumanCliArgs(common)
  if (base.mode !== 'basic') throw new Error('agentcode uses deep mode automatically; remove --mode')
  if (base.scenario !== 'chat') throw new Error('agentcode only supports the chat scenario')
  if (base.image !== undefined || base.forceTool) {
    throw new Error('agentcode does not support image or forced native-tool options')
  }
  if (noReasoning && base.showReasoning) {
    throw new Error('--show-reasoning and --no-show-reasoning cannot be used together')
  }

  const maxInputTokens = positiveInteger(values.get('--max-input-tokens') ?? '12000', '--max-input-tokens')
  const retainTokens = nonNegativeInteger(values.get('--retain-tokens') ?? '3000', '--retain-tokens')
  const maxToolCalls = positiveInteger(values.get('--max-tool-calls') ?? '64', '--max-tool-calls')
  if (retainTokens >= maxInputTokens) {
    throw new Error('--retain-tokens must be lower than --max-input-tokens')
  }

  return {
    ...base,
    mode: 'deep',
    prompt: base.prompt ?? DEFAULT_AGENTCODE_PROMPT,
    showReasoning: !noReasoning,
    workdir: resolve(cwd, values.get('--workdir') ?? 'test-human/workspaces/agentcode'),
    skillRoots: Object.freeze(uniquePaths(skillRoots)),
    maxInputTokens,
    retainTokens,
    maxToolCalls,
    once,
  }
}

export { resolveHumanModel as resolveAgentCodeModel }

export function agentCodeCliHelp(): string {
  return `Long-running coding acceptance test for tools, memory, and compaction

Usage:
  pnpm human:agentcode -- [options] [prompt]

Options:
  --workdir <path>                         Default: test-human/workspaces/agentcode
  --skills-root <path>                     Prepared skills.sh root; repeatable
  --provider <codex|openai|anthropic>      Default: codex
  --model <id>                             Codex default: gpt-5.6-luna
  --effort <id>                            Default: medium
  --max-turns <number>                     Default: 32
  --max-tool-calls <number>                Default: 64
  --max-input-tokens <number>              Auto-compact threshold; default: 12000
  --retain-tokens <number>                 Recent context retained; default: 3000
  --prompt <text>                          Override the Todo React/Zustand prompt
  --run-id <safe-id>                       Stable artifact directory suffix
  --results-root <path>                    Artifact root; default: test-human/results
  --once                                   Exit after the initial task
  --show-reasoning / --no-show-reasoning   Reasoning summaries; default: shown
  --no-logs                                Disable provider request JSONL logs
  --dry-run                                Print resolved config without filesystem/network work
  --help

Interactive session:
  While the agent is running, type a line and press Enter to steer its next safe
  model step. After completion, type another request to continue with the same
  history and memory. Commands: /memory, /history, /stats, /compact, /new,
  /abort, /quit.

The coding agent can list/read/write files, make exact sed-like replacements,
search with ripgrep, and run npm without a host shell. Direct tool paths and
command working directories are confined to --workdir; npm package code is
trusted executable code and is not filesystem-sandboxed.`
}

function hasValueFlag(argv: readonly string[], flag: string): boolean {
  return argv.some(token => token === flag || token.startsWith(`${flag}=`))
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  return paths.filter(path => {
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`)
  return value
}

function nonNegativeInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} must be a non-negative integer`)
  return value
}
