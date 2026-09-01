import type { HumanCliConfig, HumanProvider } from '../config.ts'

export type A2AStressMode = 'managed' | 'defined'

export interface A2AStressConfig {
  readonly mode: A2AStressMode
  readonly provider: HumanProvider
  readonly model: string
  readonly effort: string
  readonly maxTurns: number
  readonly maxToolCalls: number
  readonly maxInputTokens: number
  readonly retainTokens: number
  readonly timeoutMs: number
  readonly logs: boolean
  readonly runId: string
  readonly dryRun: boolean
  readonly help: boolean
}

const VALUE_FLAGS = new Set([
  '--provider', '--model', '--effort', '--max-turns', '--max-tool-calls',
  '--max-input-tokens', '--retain-tokens', '--timeout-ms', '--run-id',
])

export function parseA2AStressArgs(
  mode: A2AStressMode,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): A2AStressConfig {
  const values = new Map<string, string>()
  const switches = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    const equals = token.indexOf('=')
    if (equals > 0) {
      const key = token.slice(0, equals)
      if (!VALUE_FLAGS.has(key)) throw new Error(`unknown option: ${key}`)
      values.set(key, token.slice(equals + 1))
      continue
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`)
      values.set(token, value)
      continue
    }
    if (!['--logs', '--no-logs', '--dry-run', '--help', '-h'].includes(token)) {
      throw new Error(`unknown option: ${token}`)
    }
    switches.add(token)
  }

  const provider = enumValue(
    values.get('--provider') ?? 'codex',
    ['codex', 'openai', 'anthropic'],
    '--provider',
  )
  const model = values.get('--model') ?? env.AI_AGENT_MODEL
    ?? (provider === 'codex' ? 'gpt-5.6-luna' : undefined)
  if (model === undefined || model.trim().length === 0) {
    throw new Error(`--model or AI_AGENT_MODEL is required for provider '${provider}'`)
  }
  const maxInputTokens = integer(values.get('--max-input-tokens') ?? '3500', '--max-input-tokens', 1)
  const retainTokens = integer(values.get('--retain-tokens') ?? '700', '--retain-tokens', 0)
  if (retainTokens >= maxInputTokens) {
    throw new Error('--retain-tokens must be lower than --max-input-tokens')
  }
  return Object.freeze({
    mode,
    provider,
    model,
    effort: values.get('--effort') ?? 'medium',
    maxTurns: integer(values.get('--max-turns') ?? '18', '--max-turns', 1),
    maxToolCalls: integer(values.get('--max-tool-calls') ?? '64', '--max-tool-calls', 1),
    maxInputTokens,
    retainTokens,
    timeoutMs: integer(values.get('--timeout-ms') ?? '1200000', '--timeout-ms', 1_000),
    logs: switches.has('--logs') && !switches.has('--no-logs'),
    runId: runId(values.get('--run-id') ?? defaultRunId()),
    dryRun: switches.has('--dry-run'),
    help: switches.has('--help') || switches.has('-h'),
  })
}

export function humanConfigForA2AStress(config: A2AStressConfig): HumanCliConfig {
  return {
    provider: config.provider,
    model: config.model,
    mode: 'basic',
    scenario: 'chat',
    effort: config.effort,
    maxTurns: config.maxTurns,
    showReasoning: false,
    forceTool: false,
    logs: config.logs,
    help: false,
    dryRun: false,
  }
}

export function a2aStressHelp(mode: A2AStressMode): string {
  return `A2A ${mode} website MVP stress test

Usage:
  npm run human:a2a-${mode} -- [options]

Options:
  --provider <codex|openai|anthropic>  Default: codex
  --model <id>                         Codex default: gpt-5.6-luna
  --effort <id>                        Default: medium
  --max-turns <n>                      Per-agent model-turn budget; default: 18
  --max-tool-calls <n>                 Per-agent tool budget; default: 64
  --max-input-tokens <n>               Forced compaction threshold; default: 3500
  --retain-tokens <n>                  Verbatim tail after compaction; default: 700
  --timeout-ms <n>                     Whole-run timeout; default: 1200000
  --run-id <safe-id>                   Stable output suffix
  --logs                               Opt in to exact provider request JSONL (may contain sensitive prompts)
  --no-logs                            Explicitly disable provider request JSONL
  --dry-run                            Print the fixed deep prompt without provider I/O
  --help

Artifacts are retained under test-human/workspaces/a2a-stress and
test-human/results/a2a-stress.`
}

function enumValue<const T extends string>(value: string, values: readonly T[], flag: string): T {
  if ((values as readonly string[]).includes(value)) return value as T
  throw new Error(`${flag} must be one of: ${values.join(', ')}`)
}

function integer(value: string, flag: string, minimum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} must be an integer >= ${minimum}`)
  }
  return parsed
}

function runId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error('--run-id must contain only letters, digits, _ or -')
  }
  return value
}

function defaultRunId(): string {
  return new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)
}
