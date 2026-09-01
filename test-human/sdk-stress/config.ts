import { resolve } from 'node:path'
import { stripCommandSeparators } from '../cli-args.ts'
import type { SdkStressConfig, SdkStressProfile } from './types.ts'

const VALUE_FLAGS = new Set([
  '--profile', '--scenario', '--repeat', '--parallel', '--seed', '--timeout-ms', '--run-id', '--results-root',
])

export function parseSdkStressArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): SdkStressConfig {
  const input = stripCommandSeparators(argv)
  const values = new Map<string, string[]>()
  const switches = new Set<string>()
  for (let index = 0; index < input.length; index++) {
    const token = input[index]
    if (token === undefined) continue
    if (token === '-h') { switches.add('--help'); continue }
    const equals = token.indexOf('=')
    const key = equals > 0 ? token.slice(0, equals) : token
    if (VALUE_FLAGS.has(key)) {
      const value = equals > 0 ? token.slice(equals + 1) : input[++index]
      if (value === undefined || value.length === 0 || (equals < 0 && value.startsWith('--'))) {
        throw new Error(`${key} requires a value`)
      }
      values.set(key, [...values.get(key) ?? [], value])
      continue
    }
    if (['--fail-fast', '--verbose', '--dry-run', '--help'].includes(token)) {
      switches.add(token)
      continue
    }
    throw new Error(`unknown sdk-stress option: ${token}`)
  }
  const profile = enumValue(last(values, '--profile') ?? 'complex', ['complex', 'stress', 'soak'], '--profile')
  return Object.freeze({
    profile,
    scenarioIds: Object.freeze([...(values.get('--scenario') ?? [])]),
    repeat: positiveInteger(last(values, '--repeat') ?? '1', '--repeat'),
    parallel: positiveInteger(last(values, '--parallel') ?? defaultParallel(profile), '--parallel'),
    seed: nonNegativeInteger(last(values, '--seed') ?? '20260901', '--seed'),
    timeoutMs: positiveInteger(last(values, '--timeout-ms') ?? defaultTimeout(profile), '--timeout-ms'),
    runId: safeSegment(last(values, '--run-id') ?? defaultRunId()),
    resultsRoot: resolve(cwd, last(values, '--results-root') ?? 'test-human/results/sdk-stress'),
    failFast: switches.has('--fail-fast'),
    verbose: switches.has('--verbose'),
    dryRun: switches.has('--dry-run'),
    help: switches.has('--help'),
  })
}

export function sdkStressHelp(): string {
  return `Hermetic SDK customer-journey stress harness

Usage:
  pnpm human:sdk-stress [run] [options]

Options:
  --profile <complex|stress|soak>  Workload scale; default: complex
  --scenario <id>                 Repeat to select scenarios
  --repeat <number>               Repetitions per scenario; default: 1
  --parallel <number>             Isolated cases in flight
  --seed <number>                 Deterministic base seed; default: 20260901
  --timeout-ms <number>           Per-case deadline
  --run-id <safe-id>              Stable artifact directory suffix
  --results-root <path>           Artifact root
  --fail-fast                     Stop scheduling after first failure
  --verbose                       Print case starts as well as completions
  --dry-run                       Validate and emit a plan artifact
  --help

Profiles intentionally increase from complex integration coverage to high-volume
stress and soak. Every case writes support-safe summary.json + events.jsonl.`
}

export function profileIterations(profile: SdkStressProfile): number {
  if (profile === 'complex') return 32
  if (profile === 'stress') return 256
  return 2_048
}

function enumValue<const T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`${flag} must be one of: ${allowed.join(', ')}`)
}

function last(values: ReadonlyMap<string, readonly string[]>, key: string): string | undefined {
  return values.get(key)?.at(-1)
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`)
  return value
}

function nonNegativeInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} must be a non-negative integer`)
  return value
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('--run-id must be one safe path segment of at most 128 characters')
  }
  return value
}

function defaultParallel(profile: SdkStressProfile): string {
  return profile === 'complex' ? '2' : profile === 'stress' ? '4' : '8'
}

function defaultTimeout(profile: SdkStressProfile): string {
  return profile === 'complex' ? '120000' : profile === 'stress' ? '300000' : '900000'
}

function defaultRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}`
}
