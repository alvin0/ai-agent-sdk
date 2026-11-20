import { createAgentRuntime, defineTool, ModelError, ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
import { codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'
import {
  booleanQuestion, choiceQuestion, createDecisionRuntime, createDecisionTask, gateBoolean, gateChoice,
  llmDecisionPlugin, scoreQuestion, type DecisionResult,
} from '@alvin0/ai-agent-sdk-decision-adapter'
import { codexAdapter } from '@alvin0/ai-agent-sdk-provider-codex'
import { typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe'
import { openAiAdapter, openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import { openAiDecisionPlugin } from '@alvin0/ai-agent-sdk-provider-openai/decisions'
import { findDecisionCodexAuth } from './decision-codex-auth.mts'
import { decisionSampleModel } from './decision-sample-model.mts'

// Opt-in acceptance: pnpm human:decision:all
// Log only bounded diagnostics, model IDs, counters and latency.
const outputModes = ['json-schema', 'tool'] as const
const focus = process.env.DECISION_SMOKE_FOCUS
const validFocus = new Set([
  'typesafe', 'openai-native', 'openai-evidence', ...outputModes.map(mode => `openai-${mode}`),
])
if (focus && !validFocus.has(focus)) throw new Error('Invalid DECISION_SMOKE_FOCUS')

const nativeModel = 'gpt-6-luna'
const usesGeneration = focus !== 'typesafe' && focus !== 'openai-native'
const openaiModel = usesGeneration
  ? decisionSampleModel(process.env.OPENAI_DECISION_MODEL ?? process.env.OPENAI_MODEL)
  : nativeModel

const typesafeModel = process.env.TYPESAFE_MODEL ?? 'jev-latest'
const typesafeKey = process.env.TYPESAFE_API_KEY?.trim()
const openaiKey = process.env.OPENAI_API_KEY?.trim()
const codex = !openaiKey && focus !== 'typesafe' ? await findDecisionCodexAuth() : undefined
const nativeCredential = openaiKey || codex?.credential

const questions = {
  department: choiceQuestion('Which department should handle the customer request?', {
    billing: 'Invoices, payments, refunds', technical: 'Software bugs, outages', sales: 'New purchases, pricing',
  }),
  urgency: scoreQuestion('How urgent is this request?', [
    'Routine; no time constraint', 'Time-sensitive; needs help today', 'Critical emergency; immediate action required',
  ]),
  refund: booleanQuestion('Is the customer explicitly asking for a refund?'),
}
const billing = {
  en: 'I was charged twice for the same invoice. Please refund the duplicate charge today.',
  vi: 'Tôi bị trừ tiền hai lần cho cùng một hóa đơn. Vui lòng hoàn lại khoản thu trùng trong hôm nay.',
}
const otherDepartments = {
  technical: 'Our production application is completely down. Please investigate and restore service immediately. ' +
    'We are not requesting a refund.',
  sales: 'We want to purchase 20 new licenses. Please send pricing and a quote. We are not requesting a refund.',
} as const
type Department = 'billing' | keyof typeof otherDepartments

type ProbeDetails = { model?: string; usage?: unknown }
type ProbeResult = ProbeDetails & {
  name: string; status: 'passed' | 'failed' | 'skipped'; latencyMs?: number; code?: string; detail?: string
}
const cases: ProbeResult[] = []
const record = (row: ProbeResult) => {
  cases.push(row)
  console.log(JSON.stringify(row))
}
const skip = (name: string) => record({ name, status: 'skipped', code: 'CREDENTIAL_NOT_CONFIGURED' })
const safeDiagnostics = new Set([
  'LLM decision generation did not complete successfully', 'LLM decision fields do not match the requested schema',
  'Missing or ambiguous LLM decision output', 'Score does not match its probability distribution',
  'Score is outside its rubric', 'Choice is not a maximum-probability option',
  'LLM boolean does not agree with its evidence', 'Probabilities must sum to one', 'Invalid decision probability',
  'Invalid LLM decision stream sequence', 'Unexpected LLM decision tool', 'Unexpected LLM decision content',
  'Duplicate LLM decision block', 'LLM decision returned invalid JSON', 'Boolean answer must contain a boolean value',
  'Answer selected an unknown option', 'Unexpected choice, score or predicate', 'Native evidence did not pass gates',
  'LLM decision answer must be an object', 'LLM decision answers must be an object',
  'LLM decision output must be an object',
])

function assertAnswer(result: DecisionResult<typeof questions>, native = false, department: Department = 'billing') {
  const expectedUrgency = { billing: 1, technical: 2, sales: 0 }[department]
  if (result.answers.department.choice !== department || result.answers.refund.value !== (department === 'billing') ||
    Math.round(result.answers.urgency.score) !== expectedUrgency) {
    throw new ModelError('Unexpected choice, score or predicate', 'ACCEPTANCE_FAILED')
  }
  if (native) {
    const route = gateChoice(result.answers.department, { minProbability: 0.8, minMargin: 0.2 })
    const refund = gateBoolean(result.answers.refund, { falseMax: 0.2, trueMin: 0.8 })
    const scoreSource = result.answers.urgency.probabilitySource
    if (route.status !== 'accepted' || refund.status !== 'accepted' || scoreSource !== 'provider') {
      throw new ModelError('Native evidence did not pass gates', 'ACCEPTANCE_FAILED')
    }
  }
}

async function probe(name: string, work: () => Promise<ProbeDetails>): Promise<void> {
  const started = performance.now()
  const latency = () => Math.round(performance.now() - started)
  try {
    const details = await work()
    record({ name, status: 'passed', latencyMs: latency(), ...details })
  } catch (error) {
    const code = error instanceof ModelError ? error.code : 'ACCEPTANCE_FAILED'
    const detail = error instanceof ModelError && safeDiagnostics.has(error.message) ? error.message : undefined
    record({ name, status: 'failed', latencyMs: latency(), code, ...(detail ? { detail } : {}) })
    process.exitCode = 1
  }
}

const retryPolicy = { mode: 'normal' as const, maxRetries: 0 }
const transport = { requestTimeoutMs: 60_000, retryPolicy }
const generationAdapter = usesGeneration && (openaiKey
  ? openAiAdapter({ apiKey: openaiKey, ...transport })
  : codex && codexAdapter({ authStore: codex.authStore, models: [{ id: openaiModel }], ...transport }))
const generation = { maxTokens: 1_024, reasoningEffort: ReasoningEffortId('none') }
const runtime = createDecisionRuntime({ timeoutMs: 60_000, retryPolicy, providers: [
  ...(typesafeKey ? [typesafePlugin({ apiKey: typesafeKey, ...transport })] : []),
  ...(nativeCredential ? [openAiDecisionPlugin({
    apiKey: nativeCredential, routes: ['openai-native'], ...transport,
  })] : []),
  ...(generationAdapter ? outputModes.map(outputMode => llmDecisionPlugin({
    id: `openai-${outputMode}`, routes: [`openai-${outputMode}`], adapter: generationAdapter, outputMode, generation,
  })) : []),
  ...(generationAdapter ? [llmDecisionPlugin({
    id: 'openai-evidence', routes: ['openai-evidence'], adapter: generationAdapter,
    evidence: 'model-generated', generation,
  })] : []),
] })

async function probeCoreTool(): Promise<ProbeDetails> {
  const task = createDecisionTask(runtime.decisionModel({ provider: 'typesafe', model: typesafeModel }), { questions })
  const core = await createAgentRuntime({ providers: [codex
    ? codexNodeProviderPlugin({
      authStore: codex.authStore, defaultModel: openaiModel, models: [{ id: openaiModel }], ...transport,
    })
    : openAiPlugin({ apiKey: openaiKey!, defaultModel: openaiModel, ...transport })] })
  let toolRuns = 0
  try {
    const tool = defineTool<{ message: string }>({
      name: 'classify_ticket', description: 'Classify a customer ticket into the right department.',
      parameters: {
        type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false,
      },
      parse(raw) {
        if (raw === null || typeof raw !== 'object' || !('message' in raw) || typeof raw.message !== 'string') {
          throw new Error('message required')
        }
        return { message: raw.message }
      },
      async execute(args, ctx) {
        toolRuns++
        const result = await task.evaluate(args.message, { signal: ctx.signal }, {
          ...(ctx.logger ? { logger: ctx.logger } : {}),
        })
        assertAnswer(result, true)
        return { department: result.answers.department.choice }
      },
    })
    const result = await core.agent({
      id: 'decision-live', model: { provider: codex ? 'codex' : 'openai', id: openaiModel },
      instructions: 'Call classify_ticket once with the customer message. Reply only with its returned department.',
      tools: [tool], compaction: false,
    }).generate(billing.en)
    const text = result.message?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    if (toolRuns !== 1 || !text.toLowerCase().includes('billing')) {
      throw new ModelError('Core tool integration failed', 'ACCEPTANCE_FAILED')
    }
    return { model: openaiModel }
  } finally {
    await core.close()
  }
}

try {
  const oauthAuth = codex ? 'codex-oauth' : 'unconfigured'
  console.log(JSON.stringify({ openaiAuth: openaiKey ? 'api-key' : oauthAuth }))
  for (const { provider, model, native, configured } of [
    { provider: 'typesafe', model: typesafeModel, native: true, configured: typesafeKey },
    { provider: 'openai-native', model: nativeModel, native: true, configured: nativeCredential },
    ...outputModes.map(mode => ({
      provider: `openai-${mode}`, model: openaiModel, native: false, configured: generationAdapter,
    })),
  ]) {
    if (focus && provider !== focus) continue
    if (!configured) {
      skip(provider)
      continue
    }
    const task = createDecisionTask(runtime.decisionModel({ provider, model }), { questions })
    for (const [language, state] of Object.entries(billing)) {
      await probe(`${provider}/${language}`, async () => {
        const result = await task.evaluate(state, {}, {
          providerOptions: { headers: { 'x-sdk-decision-smoke': 'quality' } },
        })
        assertAnswer(result, native)
        return { model: result.model, usage: result.usage }
      })
    }
    for (const department of ['technical', 'sales'] as const) {
      await probe(`${provider}/${department}-no-refund`, async () => {
        const result = await task.evaluate(otherDepartments[department])
        assertAnswer(result, native, department)
        return { model: result.model, usage: result.usage }
      })
    }
    await probe(`${provider}/batch`, async () => {
      const rows = await task.evaluateBatch(Object.values(billing), { concurrency: 2, timeoutMs: 60_000 })
      return { usage: rows.map(row => {
        if (row.status !== 'fulfilled') throw row.reason
        assertAnswer(row.value, native)
        return row.value.usage
      }) }
    })
  }
  if (!focus || focus === 'openai-evidence') {
    const name = 'openai/model-generated-evidence'
    if (!generationAdapter) skip(name)
    else await probe(name, async () => {
      const model = runtime.decisionModel({ provider: 'openai-evidence', model: openaiModel })
      const result = await model.evaluate({ state: billing.en, questions })
      assertAnswer(result)
      const gate = gateChoice(result.answers.department, { minProbability: 0.8 })
      if (result.answers.department.probabilitySource !== 'model-generated' || gate.status !== 'abstained') {
        throw new ModelError('Evidence provenance contract failed', 'ACCEPTANCE_FAILED')
      }
      return { model: result.model, usage: result.usage }
    })
  }
  if (!focus) {
    const name = 'core/openai-tool-typesafe'
    if (!generationAdapter || !typesafeKey) skip(name)
    else await probe(name, probeCoreTool)
  }
} finally {
  await runtime.close()
  const summary = Object.fromEntries(['passed', 'failed', 'skipped'].map(status => [
    status, cases.filter(row => row.status === status).length,
  ]))
  console.log(JSON.stringify({ summary }))
}
