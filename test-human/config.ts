/** Pure command-line parsing for the human test harness. */

export type HumanProvider = 'codex' | 'openai' | 'anthropic'
export type HumanMode = 'basic' | 'deep' | 'deep-human-in-loop'
export type HumanScenario = 'chat' | 'web' | 'vision' | 'image-gen'

export interface HumanCliConfig {
  readonly provider: HumanProvider
  readonly model?: string
  readonly mode: HumanMode
  readonly scenario: HumanScenario
  readonly effort: string
  readonly maxTurns: number
  readonly prompt?: string
  readonly image?: string
  readonly showReasoning: boolean
  readonly forceTool: boolean
  readonly logs: boolean
  readonly help: boolean
  readonly dryRun: boolean
}

const VALUE_FLAGS = new Set([
  '--provider', '--model', '--mode', '--scenario', '--effort', '--max-turns', '--prompt', '--image',
])

export function parseHumanCliArgs(argv: readonly string[]): HumanCliConfig {
  const values = new Map<string, string>()
  const switches = new Set<string>()
  const trailing: string[] = []
  let positional = false

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    if (positional) { trailing.push(token); continue }
    if (token === '--') { positional = true; continue }
    if (token === '-h') { switches.add(token); continue }
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
    if (token.startsWith('--')) {
      if (!['--show-reasoning', '--force-tool', '--no-force-tool', '--logs', '--no-logs', '--help', '--dry-run'].includes(token)) {
        throw new Error(`unknown option: ${token}`)
      }
      switches.add(token)
      continue
    }
    trailing.push(token)
  }

  const provider = enumValue(values.get('--provider') ?? 'codex', ['codex', 'openai', 'anthropic'], '--provider')
  const mode = enumValue(values.get('--mode') ?? 'basic', ['basic', 'deep', 'deep-human-in-loop'], '--mode')
  const scenario = enumValue(values.get('--scenario') ?? 'chat', ['chat', 'web', 'vision', 'image-gen'], '--scenario')
  const rawTurns = values.get('--max-turns') ?? '8'
  const maxTurns = Number(rawTurns)
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('--max-turns must be a positive integer')
  if (switches.has('--force-tool') && switches.has('--no-force-tool')) {
    throw new Error('--force-tool and --no-force-tool cannot be used together')
  }
  const prompt = values.get('--prompt') ?? (trailing.length === 0 ? undefined : trailing.join(' '))
  const model = values.get('--model')
  const image = values.get('--image')
  const defaultForce = scenario === 'web' || scenario === 'image-gen'

  return {
    provider,
    ...model === undefined ? {} : { model },
    mode,
    scenario,
    effort: values.get('--effort') ?? 'medium',
    maxTurns,
    ...prompt === undefined ? {} : { prompt },
    ...image === undefined ? {} : { image },
    showReasoning: switches.has('--show-reasoning'),
    forceTool: switches.has('--force-tool') || (!switches.has('--no-force-tool') && defaultForce),
    logs: switches.has('--logs') && !switches.has('--no-logs'),
    help: switches.has('--help') || switches.has('-h'),
    dryRun: switches.has('--dry-run'),
  }
}

function enumValue<const T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`${flag} must be one of: ${allowed.join(', ')}`)
}

export function resolveHumanModel(config: HumanCliConfig, env: NodeJS.ProcessEnv): string {
  const model = config.model ?? env.AI_AGENT_MODEL
  if (model !== undefined && model.length > 0) return model
  if (config.provider === 'codex') return 'gpt-5.6-luna'
  throw new Error(`--model or AI_AGENT_MODEL is required for provider '${config.provider}'`)
}

export function humanCliHelp(): string {
  return `Human test harness for ai-agent-sdk

Usage:
  npm run human -- [options] [prompt]

Options:
  --provider <codex|openai|anthropic>       Default: codex
  --model <id>                              Codex default: gpt-5.6-luna
  --mode <basic|deep|deep-human-in-loop>    Default: basic
  --scenario <chat|web|vision|image-gen>    Default: chat
  --effort <id>                             Default: medium
  --max-turns <number>                      Default: 8
  --prompt <text>                           Run once; omit for interactive REPL
  --image <path|url|file-id:ID>             Required by vision scenario
  --show-reasoning                          Print provider-emitted reasoning summaries
  --logs                                    Enable high-risk exact provider-wire logs
  --force-tool / --no-force-tool            Override scenario tool choice
  --no-logs                                 Disable daily provider request JSONL
  --dry-run                                 Validate and print config without network
  --help

REPL commands: /new, /history, /memory, /remember, /forget, /compact, /quit
Environment: OPENAI_API_KEY, ANTHROPIC_API_KEY, AI_AGENT_MODEL, NO_COLOR`
}
