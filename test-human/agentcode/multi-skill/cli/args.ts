import { resolve, join } from 'node:path'
import { agentCodeCliHelp, parseAgentCodeCliArgs, resolveAgentCodeModel } from '../../config.ts'
import { SIGNAL_DESK_PROMPT } from '../prompt.ts'
import type { HarnessFlags, MultiSkillCliConfig } from './contracts.ts'

export const PROJECT_ROOT = resolve(process.cwd())
const DEFAULT_WORKSPACE = join(PROJECT_ROOT, 'test-human', 'workspaces', 'agentcode-multiskill')
const DEFAULT_REPORT_DIRECTORY = join(PROJECT_ROOT, 'test-human', 'results', 'agentcode-multiskill')
export const DEFAULT_SKILLS_ROOT = join(PROJECT_ROOT, 'test-human', 'skill-stress', '.cache', 'skills')
const AGENT_VALUE_FLAGS = new Set([
  '--provider', '--model', '--mode', '--scenario', '--effort', '--max-turns', '--prompt', '--image', '--workdir', '--skills-root', '--max-input-tokens', '--retain-tokens', '--max-tool-calls',
])

export function parseMultiSkillCliArgs(argv: readonly string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): MultiSkillCliConfig {
  const harness = extractHarnessFlags(argv, cwd)
  const separator = harness.agentArgs.indexOf('--')
  const positionalTail = separator < 0 ? [] : harness.agentArgs.slice(separator)
  const presets = separator < 0 ? [...harness.agentArgs] : [...harness.agentArgs.slice(0, separator)]
  const promptProvided = hasPromptInput(harness.agentArgs)
  addValuePreset(presets, '--workdir', DEFAULT_WORKSPACE)
  addValuePreset(presets, '--provider', 'codex')
  if ((argumentValue(presets, '--provider') ?? 'codex') === 'codex') addValuePreset(presets, '--model', 'gpt-5.6-luna')
  addValuePreset(presets, '--effort', 'medium'); addValuePreset(presets, '--max-turns', '48'); addValuePreset(presets, '--max-tool-calls', '128')
  addValuePreset(presets, '--max-input-tokens', '12000'); addValuePreset(presets, '--retain-tokens', '3000')
  if (!promptProvided) presets.push('--prompt', SIGNAL_DESK_PROMPT)
  if (!hasSwitch(presets, '--once')) presets.push('--once')
  if (!hasPathValue(presets, '--skills-root', DEFAULT_SKILLS_ROOT, cwd)) presets.push('--skills-root', DEFAULT_SKILLS_ROOT)
  presets.push(...positionalTail)
  const agent = parseAgentCodeCliArgs(presets, cwd)
  return Object.freeze({ agent, model: resolveAgentCodeModel(agent, env), reportDirectory: harness.reportDirectory, repairTurns: harness.repairTurns })
}

export function multiSkillCliHelp(): string {
  return `Automated real-provider Signal Desk multi-skill acceptance

Usage:
  node test-human/agentcode/multi-skill/cli.ts [harness options] [AgentCode options]

Harness options:
  --report-dir <path>     Reports and isolated provider logs; default:
                          test-human/results/agentcode-multiskill
  --repair-turns <count>  Continuation repair turns in the same session; default: 1

AgentCode presets (all remain overridable):
  --workdir test-human/workspaces/agentcode-multiskill
  --provider codex --model gpt-5.6-luna --effort medium
  --max-turns 48 --max-tool-calls 128
  --max-input-tokens 12000 --retain-tokens 3000 --once

--help and --dry-run perform no filesystem mutation and make no network request.
All remaining options are parsed by the AgentCode CLI parser.

${agentCodeCliHelp()}`
}

function extractHarnessFlags(argv: readonly string[], cwd: string): HarnessFlags {
  const agentArgs: string[] = []; let reportDirectory = DEFAULT_REPORT_DIRECTORY; let repairTurns = 1; let positional = false
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]; if (token === undefined) continue
    if (positional) { agentArgs.push(token); continue }
    if (token === '--') { positional = true; agentArgs.push(token); continue }
    const equals = token.indexOf('='); const key = equals > 0 ? token.slice(0, equals) : token
    if (key !== '--report-dir' && key !== '--repair-turns') { agentArgs.push(token); continue }
    const value = equals > 0 ? token.slice(equals + 1) : argv[++index]
    if (value === undefined || value.length === 0 || (equals < 0 && value.startsWith('--'))) throw new Error(`${key} requires a value`)
    if (key === '--report-dir') reportDirectory = resolve(cwd, value); else repairTurns = boundedRepairTurns(value)
  }
  return Object.freeze({ reportDirectory: resolve(reportDirectory), repairTurns, agentArgs: Object.freeze(agentArgs) })
}
function addValuePreset(argv: string[], flag: string, value: string): void { if (!hasValueFlag(argv, flag)) argv.push(flag, value) }
function hasValueFlag(argv: readonly string[], flag: string): boolean { return argv.some(token => token === flag || token.startsWith(`${flag}=`)) }
function argumentValue(argv: readonly string[], flag: string): string | undefined {
  for (let index = argv.length - 1; index >= 0; index--) { const token = argv[index]; if (token?.startsWith(`${flag}=`)) return token.slice(flag.length + 1); if (token === flag) return argv[index + 1] }
  return undefined
}
function hasPromptInput(argv: readonly string[]): boolean {
  let positional = false
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]; if (token === undefined) continue
    if (positional) return true
    if (token === '--') { positional = true; continue }
    const equals = token.indexOf('='); const key = equals > 0 ? token.slice(0, equals) : token
    if (key === '--prompt') return true
    if (AGENT_VALUE_FLAGS.has(key)) { if (equals < 0) index++; continue }
    if (!token.startsWith('-')) return true
  }
  return false
}
function hasSwitch(argv: readonly string[], flag: string): boolean { return argv.includes(flag) }
function hasPathValue(argv: readonly string[], flag: string, expected: string, cwd: string): boolean {
  for (let index = 0; index < argv.length; index++) { const token = argv[index]; if (token === undefined) continue
    if (token.startsWith(`${flag}=`)) { if (samePath(resolve(cwd, token.slice(flag.length + 1)), expected)) return true }
    else if (token === flag) { const value = argv[index + 1]; if (value !== undefined && samePath(resolve(cwd, value), expected)) return true }
  }
  return false
}
function boundedRepairTurns(raw: string): number { const value = Number(raw); if (!Number.isSafeInteger(value) || value < 0 || value > 4) throw new Error('--repair-turns must be an integer between 0 and 4'); return value }
export function samePath(left: string, right: string): boolean { const a = resolve(left); const b = resolve(right); return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b }
