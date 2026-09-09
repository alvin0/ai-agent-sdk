import { createAgentRuntime, defineTool } from '@alvin0/ai-agent-sdk-core'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'
import { geminiPlugin } from '@alvin0/ai-agent-sdk-provider-gemini'
import {
  HumanArtifactRecorder,
  type HumanArtifactInvariant,
} from '../artifacts.ts'
import type { StructuredOutputConfig } from './config.ts'

type ScenarioId = 'short' | 'long'

export interface ReleaseCheck {
  readonly id: string
  readonly label: string
  readonly status: 'passed'
}

export interface FinalPayload {
  readonly process: ScenarioId
  readonly decision: 'ready'
  readonly checks: readonly ReleaseCheck[]
  readonly summary: string
}

export interface ScenarioResult {
  readonly id: ScenarioId
  readonly status: 'passed' | 'failed'
  readonly expectedChecks: number
  readonly toolExecutions: number
  readonly modelCalls: number
  readonly finishReasons: readonly string[]
  readonly payload?: FinalPayload
  readonly invariants: readonly HumanArtifactInvariant[]
  readonly error?: string
}

export type StructuredOutputProgressEvent =
  | { readonly type: 'scenario-start'; readonly id: ScenarioId; readonly checks: number }
  | { readonly type: 'tool-call'; readonly id: ScenarioId; readonly step: number; readonly total: number }
  | { readonly type: 'tool-result'; readonly id: ScenarioId; readonly step: number;
      readonly total: number; readonly check: ReleaseCheck }
  | { readonly type: 'final-output'; readonly id: ScenarioId; readonly payload?: FinalPayload;
      readonly finishReasons: readonly string[] }
  | { readonly type: 'scenario-end'; readonly result: ScenarioResult }

export interface StructuredOutputAcceptanceResult {
  readonly status: 'passed' | 'failed' | 'dry-run'
  readonly artifact: string
  readonly scenarios: readonly ScenarioResult[]
}

export interface StructuredOutputAcceptanceOptions {
  readonly onProgress?: (event: StructuredOutputProgressEvent) => void
}

const RELEASE_CHECKS: readonly ReleaseCheck[] = Object.freeze([
  releaseCheck('unit-tests', 'Unit tests'),
  releaseCheck('typecheck', 'TypeScript typecheck'),
  releaseCheck('lint', 'Lint and dependency boundaries'),
  releaseCheck('package-build', 'Package build'),
  releaseCheck('docs-build', 'Documentation build'),
  releaseCheck('provider-smoke', 'Live provider smoke test'),
  releaseCheck('credential-isolation', 'Credential isolation'),
  releaseCheck('retry-policy', 'Retry policy'),
  releaseCheck('tool-loop', 'Tool-loop lifecycle'),
  releaseCheck('structured-output', 'Structured output'),
  releaseCheck('cancellation', 'Cancellation path'),
  releaseCheck('observability', 'Observation delivery'),
  releaseCheck('packaging', 'Package metadata'),
  releaseCheck('node-runtime', 'Node runtime smoke test'),
  releaseCheck('edge-runtime', 'Edge runtime smoke test'),
  releaseCheck('release-manifest', 'Release manifest'),
])

export async function runStructuredOutputAcceptance(
  config: StructuredOutputConfig,
  options: StructuredOutputAcceptanceOptions = {},
): Promise<StructuredOutputAcceptanceResult> {
  const artifact = new HumanArtifactRecorder({
    harness: 'structured-output', runId: config.runId, resultsRoot: config.resultsRoot,
  })
  const selected = selectedScenarios(config)
  const publicConfig = {
    provider: config.provider,
    model: config.model,
    scenario: config.scenario,
    longSteps: config.longSteps,
    timeoutMs: config.timeoutMs,
  }
  artifact.record('plan', { ...publicConfig, scenarios: selected.map(item => item.id) })

  if (config.dryRun) {
    await artifact.finish({
      status: 'dry-run', config: publicConfig,
      invariants: [{ name: 'short and long structured-output scenarios resolve', passed: true }],
      metrics: { scenarios: selected.length },
    })
    return Object.freeze({ status: 'dry-run', artifact: artifact.summaryPath, scenarios: [] })
  }

  const results: ScenarioResult[] = []
  let runtime: Awaited<ReturnType<typeof createAgentRuntime>> | undefined
  try {
    runtime = await createAgentRuntime({
      providers: [config.provider === 'gemini'
        ? geminiPlugin({
          apiKey: envCredential('GEMINI_KEY'),
          models: [{ id: config.model, name: config.model }],
          requestTimeoutMs: config.timeoutMs,
          streamIdleTimeoutMs: config.timeoutMs,
          ...(config.verbose ? {
            requestLogger(record) { artifact.record('provider-request', record) },
          } : {}),
        })
        : codexNodeProviderPlugin({
          requestTimeoutMs: config.timeoutMs,
          streamIdleTimeoutMs: config.timeoutMs,
        })],
    })
    const catalog = await runtime.modelCatalog(config.provider)
    artifact.record('catalog', {
      state: catalog.state,
      modelCount: catalog.models.length,
      selectedModelAvailable: catalog.models.some(model => model.id === config.model),
    })
    for (const scenario of selected) {
      options.onProgress?.({ type: 'scenario-start', id: scenario.id, checks: scenario.checks.length })
      artifact.record('scenario-start', { id: scenario.id, checks: scenario.checks.length })
      const result = await runScenario(runtime, config, scenario, options, artifact)
      results.push(result)
      options.onProgress?.({ type: 'scenario-end', result })
      artifact.record('scenario-end', {
        id: result.id,
        status: result.status,
        expectedChecks: result.expectedChecks,
        toolExecutions: result.toolExecutions,
        modelCalls: result.modelCalls,
        finishReasons: result.finishReasons,
        payload: result.payload,
        invariants: result.invariants,
        ...(result.error === undefined ? {} : { error: result.error }),
      })
    }
  } catch (error: unknown) {
    const message = errorMessage(error)
    for (const scenario of selected.slice(results.length)) {
      const result = failedScenario(scenario.id, scenario.checks.length, message)
      results.push(result)
      options.onProgress?.({ type: 'scenario-end', result })
    }
  } finally {
    if (runtime !== undefined) await runtime.close()
  }

  const invariants = results.flatMap(result => result.invariants)
  const passed = results.length === selected.length
    && results.every(result => result.status === 'passed')
  await artifact.finish({
    status: passed ? 'passed' : 'failed',
    config: publicConfig,
    invariants,
    metrics: {
      scenarios: results.length,
      passed: results.filter(result => result.status === 'passed').length,
      releaseChecks: results.reduce((sum, result) => sum + result.toolExecutions, 0),
      modelCalls: results.reduce((sum, result) => sum + result.modelCalls, 0),
      processResults: results.map(result => ({
        process: result.id,
        status: result.status,
        finalOutput: result.payload ?? null,
      })),
    },
  })
  return Object.freeze({
    status: passed ? 'passed' : 'failed',
    artifact: artifact.summaryPath,
    scenarios: Object.freeze(results),
  })
}

async function runScenario(
  runtime: Awaited<ReturnType<typeof createAgentRuntime>>,
  config: StructuredOutputConfig,
  scenario: { readonly id: ScenarioId; readonly checks: readonly ReleaseCheck[] },
  options: StructuredOutputAcceptanceOptions,
  artifact: HumanArtifactRecorder,
): Promise<ScenarioResult> {
  let toolExecutions = 0
  const eventCounts = new Map<string, number>()
  const toolResultStatuses: string[] = []
  const total = scenario.checks.length
  const inspect = defineTool({
    name: 'inspect_release_check',
    description: 'Inspect one numbered release-readiness check. Start at 1 and use nextStep from each result.',
    parameters: {
      type: 'object',
      properties: { step: { type: 'integer', minimum: 1, maximum: total } },
      required: ['step'],
      additionalProperties: false,
    },
    parse(raw): { readonly step: number } {
      const step = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'step') : undefined
      if (!Number.isSafeInteger(step)) throw new TypeError('inspect_release_check.step must be an integer')
      return { step: step as number }
    },
    execute({ step }) {
      const expectedStep = toolExecutions + 1
      if (step !== expectedStep) throw new Error(`expected release check ${expectedStep}, received ${step}`)
      const check = scenario.checks[step - 1]
      if (check === undefined) throw new Error(`release check ${step} is unavailable`)
      toolExecutions = step
      artifact.record('tool-call', { process: scenario.id, step, total, name: 'inspect_release_check' })
      options.onProgress?.({ type: 'tool-call', id: scenario.id, step, total })
      artifact.record('tool-result', { process: scenario.id, step, total, check })
      options.onProgress?.({ type: 'tool-result', id: scenario.id, step, total, check })
      return Object.freeze({
        step,
        total,
        remaining: total - step,
        nextStep: step < total ? step + 1 : null,
        checkId: check.id,
        checkLabel: check.label,
        checkStatus: check.status,
      })
    },
    isConcurrencySafe: () => false,
  })
  const agent = runtime.agent({
    id: `structured-output-${scenario.id}`,
    model: { provider: config.provider, id: config.model },
    instructions: processInstructions(scenario.id, total),
    tools: [inspect],
    outputFormat: {
      type: 'json_schema',
      name: `${scenario.id}_release_readiness`,
      schema: {
        type: 'object',
        properties: {
          process: { type: 'string', enum: [scenario.id] },
          decision: { type: 'string', enum: ['ready'] },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                status: { type: 'string', enum: ['passed'] },
              },
              required: ['id', 'label', 'status'],
              additionalProperties: false,
            },
          },
          summary: { type: 'string' },
        },
        required: ['process', 'decision', 'checks', 'summary'],
        additionalProperties: false,
      },
    },
    compaction: false,
    maxTurns: total + 2,
    maxToolCalls: total,
    commentary: 'off',
  })

  try {
    const response = await agent.generate(
      `Review release readiness using the ${scenario.id} ${total}-check process.`,
      {
        signal: AbortSignal.timeout(config.timeoutMs),
        onEvent(event) {
          eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1)
          if (event.type === 'tool-result') toolResultStatuses.push(event.status)
        },
      },
    )
    const payload = parsePayload(response.text)
    const finishReasons = response.report.modelCalls.map(call => call.finishReason ?? 'unknown')
    artifact.record('final-output', {
      process: scenario.id,
      boundary: 'tools-disabled-json-schema',
      finishReasons,
      output: payload,
    })
    options.onProgress?.({
      type: 'final-output', id: scenario.id, finishReasons,
      ...(payload === undefined ? {} : { payload }),
    })
    const expectedReasons = [...Array.from({ length: total }, () => 'tool-calls'), 'stop', 'stop']
    const invariants = Object.freeze([
      invariant(`${scenario.id}: runtime reports success`, response.report.status === 'success'),
      invariant(`${scenario.id}: every release check executes once`, toolExecutions === total,
        `expected ${total}, received ${toolExecutions}`),
      invariant(`${scenario.id}: public events expose every tool boundary`,
        eventCounts.get('tool-call') === total && eventCounts.get('tool-result') === total,
        `calls=${eventCounts.get('tool-call') ?? 0}, results=${eventCounts.get('tool-result') ?? 0}`),
      invariant(`${scenario.id}: every tool result completes successfully`,
        toolResultStatuses.length === total && toolResultStatuses.every(status => status === 'completed'),
        `received ${toolResultStatuses.join(', ')}`),
      invariant(`${scenario.id}: model calls reserve a separate final-schema round`,
        arraysEqual(finishReasons, expectedReasons),
        `expected ${expectedReasons.join(' -> ')}, received ${finishReasons.join(' -> ')}`),
      invariant(`${scenario.id}: every provider attempt returns HTTP 200`,
        response.report.modelCalls.every(call => call.status === 'success'
          && call.attempts.length === 1 && call.attempts[0]?.httpStatus === 200)),
      invariant(`${scenario.id}: final release decision matches host-owned checks`,
        payloadMatches(payload, scenario.id, scenario.checks, toolExecutions),
        payload === undefined ? 'final response is not the required object' : JSON.stringify(payload)),
      invariant(`${scenario.id}: observation delivery is complete`, response.report.delivery.complete),
    ])
    return Object.freeze({
      id: scenario.id,
      status: invariants.every(item => item.passed) ? 'passed' : 'failed',
      expectedChecks: total,
      toolExecutions,
      modelCalls: response.report.modelCalls.length,
      finishReasons: Object.freeze(finishReasons),
      ...(payload === undefined ? {} : { payload }),
      invariants,
    })
  } catch (error: unknown) {
    return failedScenario(scenario.id, total, errorMessage(error), toolExecutions)
  }
}

function selectedScenarios(config: StructuredOutputConfig): readonly {
  readonly id: ScenarioId
  readonly checks: readonly ReleaseCheck[]
}[] {
  const all = Object.freeze([
    Object.freeze({ id: 'short' as const, checks: Object.freeze(RELEASE_CHECKS.slice(0, 1)) }),
    Object.freeze({ id: 'long' as const, checks: Object.freeze(RELEASE_CHECKS.slice(0, config.longSteps)) }),
  ])
  return config.scenario === 'all' ? all : all.filter(item => item.id === config.scenario)
}

function processInstructions(id: ScenarioId, total: number): string {
  return `Review release readiness with the ${id} process containing ${total} checks.
First call inspect_release_check with step=1. Call it exactly once per model turn. If remaining is
greater than zero, call it in the next turn using nextStep. Preserve every returned check in order.
When remaining reaches zero, do not call another tool; briefly state that the review process is done.
Do not emit final JSON during process rounds. The SDK then makes a separate tools-disabled final
request. Return only the schema object: process=${id}, decision=ready, the exact checks returned by
the host, and a concise human-readable summary of why the release is ready.`
}

function parsePayload(text: string): FinalPayload | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).length !== 4) return undefined
  if (record.process !== 'short' && record.process !== 'long') return undefined
  if (record.decision !== 'ready' || !Array.isArray(record.checks)) return undefined
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) return undefined
  const checks: ReleaseCheck[] = []
  for (const value of record.checks) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const check = value as Record<string, unknown>
    if (Reflect.ownKeys(check).length !== 3
      || typeof check.id !== 'string' || typeof check.label !== 'string'
      || check.status !== 'passed') return undefined
    checks.push(Object.freeze({ id: check.id, label: check.label, status: check.status }))
  }
  return Object.freeze({
    process: record.process,
    decision: record.decision,
    checks: Object.freeze(checks),
    summary: record.summary,
  })
}

function payloadMatches(
  payload: FinalPayload | undefined,
  id: ScenarioId,
  expected: readonly ReleaseCheck[],
  completed: number,
): boolean {
  if (payload === undefined || payload.process !== id || payload.decision !== 'ready') return false
  if (completed !== expected.length || payload.checks.length !== expected.length) return false
  return payload.checks.every((check, index) => {
    const source = expected[index]
    return source !== undefined && check.id === source.id
      && check.label === source.label && check.status === source.status
  })
}

function failedScenario(
  id: ScenarioId,
  expectedChecks: number,
  message: string,
  toolExecutions = 0,
): ScenarioResult {
  return Object.freeze({
    id,
    status: 'failed',
    expectedChecks,
    toolExecutions,
    modelCalls: 0,
    finishReasons: Object.freeze([]),
    invariants: Object.freeze([{
      name: `${id}: live provider scenario completes`, passed: false, detail: message,
    }]),
    error: message,
  })
}

function releaseCheck(id: string, label: string): ReleaseCheck {
  return Object.freeze({ id, label, status: 'passed' })
}

function invariant(name: string, passed: boolean, detail?: string): HumanArtifactInvariant {
  return Object.freeze({ name, passed, ...(passed || detail === undefined ? {} : { detail }) })
}

function arraysEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function errorMessage(error: unknown): string {
  const causes: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current !== error && !causes.includes(current.message)) causes.push(current.message)
    current = current.cause
  }
  if (error instanceof Error && 'report' in error) {
    const report = Reflect.get(error, 'report') as { errors?: readonly unknown[] } | undefined
    const failure = report?.errors?.at(-1)
    if (typeof failure === 'object' && failure !== null) {
      const message = Reflect.get(failure, 'message')
      const code = Reflect.get(failure, 'code')
      if (typeof message === 'string' && typeof code === 'string') {
        const detail = causes.length === 0 ? message : causes.join(': ')
        return `${error.message}: ${detail} [${code}]`
      }
    }
  }
  return error instanceof Error ? error.message : String(error)
}
