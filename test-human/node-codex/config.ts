import { resolve } from 'node:path'
import { stripCommandSeparators } from '../cli-args.ts'

export interface NodeCodexConfig {
  readonly runId: string
  readonly resultsRoot: string
  readonly repeat: number
  readonly parallel: number
  readonly dryRun: boolean
  readonly help: boolean
}

export function parseNodeCodexArgs(argv: readonly string[]): NodeCodexConfig {
  const input = stripCommandSeparators(argv)
  let runId = defaultRunId()
  let resultsRoot = resolve('test-human/results/node-codex')
  let repeat = 1
  let parallel = 1
  let dryRun = false
  let showHelp = false
  for (let index = 0; index < input.length; index++) {
    const token = input[index]
    if (token === '--run-id') runId = required(input[++index], token)
    else if (token === '--results-root') resultsRoot = resolve(required(input[++index], token))
    else if (token === '--repeat') repeat = positiveInteger(required(input[++index], token), token, 64)
    else if (token === '--parallel') parallel = positiveInteger(required(input[++index], token), token, 16)
    else if (token === '--dry-run') dryRun = true
    else if (token === '--help' || token === '-h') showHelp = true
    else throw new Error(`unknown node-codex option: ${token}`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error('--run-id must be a safe path segment')
  return { runId, resultsRoot, repeat, parallel, dryRun, help: showHelp }
}

export function nodeCodexHelp(): string {
  return `Full Node SDK Codex-like human harness

Usage: pnpm human:node-codex [options]

  --repeat <1..64>       Isolated end-to-end sessions
  --parallel <1..16>     Sessions in flight
  --run-id <safe-id>     Stable artifact/workspace id
  --results-root <path>  Artifact root
  --dry-run              Validate configuration only

Each case renders commentary and tool boundaries like a coding CLI, then proves
filesystem skills, scoped writes, syntax execution, MCP stdio, session resume,
authoritative token accounting, and a recoverable Node observation journal.`
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function positiveInteger(raw: string, flag: string, max: number): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${flag} must be an integer from 1 to ${max}`)
  return value
}

function defaultRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}`
}
