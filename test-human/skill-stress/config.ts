import { resolve } from 'node:path'
import type { HumanProvider } from '../config.ts'
import type { SkillStressConfig } from './types.ts'

const VALUE_FLAGS = new Set([
  '--suite', '--scenario', '--parallel', '--repeat', '--seed', '--timeout-ms', '--run-id',
  '--workspace-root', '--results-root', '--skills-root', '--provider', '--model', '--effort',
  '--max-turns', '--max-tool-calls', '--max-input-tokens', '--retain-tokens',
])

export function parseSkillStressArgs(
  argv: readonly string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): SkillStressConfig {
  const values = new Map<string, string[]>()
  const switches = new Set<string>()
  const input = argv[0] === 'run' ? argv.slice(1) : [...argv]
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
    if (['--logs', '--no-logs', '--keep-workspaces', '--fail-fast', '--verbose-events', '--help', '--dry-run'].includes(token)) {
      switches.add(token)
      continue
    }
    throw new Error(`unknown skill-stress option: ${token}`)
  }
  if (switches.has('--logs') && switches.has('--no-logs')) {
    throw new Error('--logs and --no-logs cannot be used together')
  }
  const suite = enumValue(
    last(values, '--suite') ?? 'offline', ['offline', 'registry', 'live', 'all'], '--suite',
  )
  const provider = enumValue(last(values, '--provider') ?? 'codex', ['codex', 'openai', 'anthropic'], '--provider')
  const model = resolveModel(provider, last(values, '--model'), env)
  const maxInputTokens = positiveInteger(last(values, '--max-input-tokens') ?? '12000', '--max-input-tokens')
  const retainTokens = nonNegativeInteger(last(values, '--retain-tokens') ?? '3000', '--retain-tokens')
  if (retainTokens >= maxInputTokens) throw new Error('--retain-tokens must be lower than --max-input-tokens')
  const runId = safeSegment(last(values, '--run-id') ?? defaultRunId())
  return Object.freeze({
    suite,
    scenarioIds: Object.freeze([...(values.get('--scenario') ?? [])]),
    parallel: positiveInteger(last(values, '--parallel') ?? '2', '--parallel'),
    repeat: positiveInteger(last(values, '--repeat') ?? '1', '--repeat'),
    seed: nonNegativeInteger(last(values, '--seed') ?? '20260831', '--seed'),
    timeoutMs: positiveInteger(last(values, '--timeout-ms') ?? '300000', '--timeout-ms'),
    runId,
    workspaceRoot: resolve(cwd, last(values, '--workspace-root') ?? 'test-human/workspaces/skill-stress'),
    resultsRoot: resolve(cwd, last(values, '--results-root') ?? 'test-human/results/skill-stress'),
    skillsRoot: resolve(cwd, last(values, '--skills-root') ?? 'test-human/skill-stress/.cache/skills'),
    provider,
    model,
    effort: last(values, '--effort') ?? 'medium',
    maxTurns: positiveInteger(last(values, '--max-turns') ?? '16', '--max-turns'),
    maxToolCalls: positiveInteger(last(values, '--max-tool-calls') ?? '64', '--max-tool-calls'),
    maxInputTokens,
    retainTokens,
    logs: switches.has('--logs') && !switches.has('--no-logs'),
    keepWorkspaces: switches.has('--keep-workspaces'),
    failFast: switches.has('--fail-fast'),
    verboseEvents: switches.has('--verbose-events'),
    help: switches.has('--help'),
    dryRun: switches.has('--dry-run'),
  })
}

export function skillStressHelp(): string {
  return `Skill progressive-disclosure stress harness

Usage:
  node test-human/skill-stress/cli.ts run [options]

Options:
  --suite <offline|registry|live|all> Default: offline
  --scenario <id>                     Repeat to select scenarios
  --parallel <number>                 Concurrent isolated cases; default: 2
  --repeat <number>                   Repetitions per scenario; default: 1
  --seed <number>                     Reproducible base seed; default: 20260831
  --timeout-ms <number>               Per-case timeout; default: 300000
  --skills-root <path>                Prepared skills.sh cache
  --workspace-root <path>             Isolated scratch workspaces
  --results-root <path>               JSON/JSONL reports
  --provider <codex|openai|anthropic> Live provider; default: codex
  --model <id>                        Codex default: gpt-5.6-luna
  --effort <id>                       Default: medium
  --max-turns <number>                Live turn budget; default: 16
  --max-tool-calls <number>           Live tool budget; default: 64
  --keep-workspaces                   Preserve successful scratch workspaces
  --fail-fast                         Stop scheduling after the first failure
  --verbose-events                    Print case lifecycle events
  --logs / --no-logs                  Provider request logs; default: disabled
  --dry-run                           Validate and list selected cases
  --help

Offline uses generated standard SKILL.md fixtures. Registry uses the prepared
skills.sh corpus with a scripted adapter and no model bill. Live uses that same
corpus with a real provider. Both require the companion prepare command.`
}

function last(values: ReadonlyMap<string, readonly string[]>, key: string): string | undefined {
  return values.get(key)?.at(-1)
}

function enumValue<const T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`${flag} must be one of: ${allowed.join(', ')}`)
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

function resolveModel(provider: HumanProvider, configured: string | undefined, env: NodeJS.ProcessEnv): string {
  const model = configured ?? env.AI_AGENT_MODEL
  if (model !== undefined && model.length > 0) return model
  if (provider === 'codex') return 'gpt-5.6-luna'
  throw new Error(`--model or AI_AGENT_MODEL is required for provider '${provider}'`)
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error('--run-id must be one safe path segment of at most 128 characters')
  }
  return value
}

function defaultRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}`
}
