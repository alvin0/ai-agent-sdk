import { resolve } from 'node:path'
import { stripCommandSeparators } from '../cli-args.ts'

export type StructuredOutputScenario = 'short' | 'long' | 'all'
export type StructuredOutputProvider = 'codex' | 'gemini'

export interface StructuredOutputConfig {
  readonly runId: string
  readonly resultsRoot: string
  readonly provider: StructuredOutputProvider
  readonly model: string
  readonly scenario: StructuredOutputScenario
  readonly longSteps: number
  readonly timeoutMs: number
  readonly verbose: boolean
  readonly dryRun: boolean
  readonly help: boolean
}

export function parseStructuredOutputArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): StructuredOutputConfig {
  const input = stripCommandSeparators(argv)
  let runId = defaultRunId()
  let resultsRoot = resolve('test-human/results/structured-output')
  let provider: StructuredOutputProvider = 'codex'
  let model: string | undefined
  let scenario: StructuredOutputScenario = 'all'
  let longSteps = 6
  let timeoutMs = 120_000
  let verbose = false
  let dryRun = false
  let help = false

  for (let index = 0; index < input.length; index++) {
    const token = input[index]
    if (token === '--run-id') runId = required(input[++index], token)
    else if (token === '--results-root') resultsRoot = resolve(required(input[++index], token))
    else if (token === '--provider') provider = selectedProvider(required(input[++index], token))
    else if (token === '--model') model = required(input[++index], token)
    else if (token === '--scenario') scenario = selectedScenario(required(input[++index], token))
    else if (token === '--long-steps') longSteps = boundedInteger(required(input[++index], token), token, 3, 16)
    else if (token === '--timeout-ms') timeoutMs = boundedInteger(required(input[++index], token), token, 10_000, 600_000)
    else if (token === '--verbose') verbose = true
    else if (token === '--dry-run') dryRun = true
    else if (token === '--help' || token === '-h') help = true
    else throw new Error(`unknown structured-output option: ${token}`)
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('--run-id must be a safe path segment')
  }
  model ??= provider === 'gemini' ? env.GEMINI_MODEL : 'gpt-5.6-luna'
  if (model === undefined && help) model = 'GEMINI_MODEL'
  if (model === undefined) throw new Error('--provider gemini requires --model or GEMINI_MODEL')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
    throw new Error('--model must be a bounded model identifier')
  }
  return Object.freeze({
    runId, resultsRoot, provider, model, scenario, longSteps, timeoutMs, verbose, dryRun, help,
  })
}

export function structuredOutputHelp(): string {
  return `Live provider structured-output acceptance harness

Usage: pnpm human:structured-output -- [options]

  --scenario <all|short|long>  Scenario selection; defaults to all
  --provider <codex|gemini>    Live provider; defaults to codex
  --model <id>                 Explicit model; Gemini defaults to GEMINI_MODEL
  --long-steps <3..16>         Tool rounds in the long process; defaults to 6
  --timeout-ms <10000..600000> Timeout per scenario; defaults to 120000
  --verbose                    Show diagnostic invariants after the walkthrough
  --run-id <safe-id>           Stable artifact id
  --results-root <path>        Artifact root
  --dry-run                    Validate and write the plan without network calls

The short process executes one host tool round. The long process executes the
configured number of sequential tool rounds. Both must then complete one text
process round and a separate no-tools JSON Schema final round.`
}

function selectedProvider(value: string): StructuredOutputProvider {
  if (value === 'codex' || value === 'gemini') return value
  throw new Error('--provider must be one of codex or gemini')
}

function selectedScenario(value: string): StructuredOutputScenario {
  if (value === 'short' || value === 'long' || value === 'all') return value
  throw new Error('--scenario must be one of all, short, or long')
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function boundedInteger(raw: string, flag: string, minimum: number, maximum: number): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function defaultRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}`
}
