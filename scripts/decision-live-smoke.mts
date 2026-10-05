import { createAgentRuntime, defineTool, ModelError } from '@alvin0/ai-agent-sdk-core'
import { booleanQuestion, choiceQuestion, createDecisionRuntime, createDecisionTask, gateBoolean, gateChoice, llmDecisionPlugin, scoreQuestion, type DecisionResult } from '@alvin0/ai-agent-sdk-decision-adapter'
import { typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe'
import { openAiAdapter, openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

// Opt-in acceptance only: node --env-file=.env scripts/decision-live-smoke.mts
// Never log credentials, raw provider errors, endpoint query strings or headers.
const openaiKey = process.env.OPENAI_API_KEY
const typesafeKey = process.env.TYPESAFE_API_KEY
// Project policy: gpt-6-luna minimum; model overrides must select it or a newer model.
const openaiModel = process.env.OPENAI_DECISION_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-6-luna'
const typesafeModel = process.env.TYPESAFE_MODEL ?? 'jev-latest'
const questions = {
  department: choiceQuestion('Which department should handle the customer request?', { billing: 'Invoices, payments, refunds', technical: 'Software bugs, outages', sales: 'New purchases, pricing' }),
  urgency: scoreQuestion('How urgent is this request?', ['Routine; no time constraint', 'Time-sensitive; needs help today', 'Critical emergency; immediate action required']),
  refund: booleanQuestion('Is the customer explicitly asking for a refund?'),
}
const states = [
  'I was charged twice for the same invoice. Please refund the duplicate charge today.',
  'Tôi bị trừ tiền hai lần cho cùng một hóa đơn. Vui lòng hoàn lại khoản thu trùng trong hôm nay.',
] as const
const cases: { name: string; status: 'passed' | 'failed' | 'skipped'; latencyMs?: number; code?: string; detail?: string; usage?: unknown; model?: string }[] = []
const safeDiagnostics = new Set(['LLM decision generation did not complete successfully', 'LLM decision fields do not match the requested schema', 'Missing or ambiguous LLM decision output', 'Score does not match its probability distribution', 'Score is outside its rubric', 'Choice is not a maximum-probability option', 'LLM boolean does not agree with its evidence', 'Probabilities must sum to one', 'Invalid decision probability', 'Invalid LLM decision stream sequence', 'Unexpected LLM decision tool', 'Unexpected LLM decision content', 'Duplicate LLM decision block', 'LLM decision returned invalid JSON', 'Boolean answer must contain a boolean value', 'Answer selected an unknown option'])
for (const label of ['LLM decision answer', 'LLM decision answers', 'LLM decision output']) safeDiagnostics.add(`${label} must be an object`)
function assertAnswer(result: DecisionResult<typeof questions>, native = false, department: 'billing' | 'technical' | 'sales' = 'billing', wantsRefund = true): void {
  if (result.answers.department.choice !== department || result.answers.refund.value !== wantsRefund) throw new ModelError('Unexpected classification', 'ACCEPTANCE_FAILED')
  if (native) {
    const route = gateChoice(result.answers.department, { minProbability: 0.8, minMargin: 0.2 })
    const refund = gateBoolean(result.answers.refund, { falseMax: 0.2, trueMin: 0.8 })
    if (route.status !== 'accepted' || refund.status !== 'accepted') throw new ModelError('Native evidence did not pass gates', 'ACCEPTANCE_FAILED')
  }
}
async function probe(name: string, work: () => Promise<{ model?: string; usage?: unknown }>): Promise<void> {
  const started = performance.now()
  try {
    const details = await work()
    cases.push({ name, status: 'passed', latencyMs: Math.round(performance.now() - started), ...details })
  } catch (error) {
    cases.push({ name, status: 'failed', latencyMs: Math.round(performance.now() - started), code: error instanceof ModelError ? error.code : 'ACCEPTANCE_FAILED', ...(error instanceof ModelError && safeDiagnostics.has(error.message) ? { detail: error.message } : {}) })
    process.exitCode = 1
  }
  console.log(JSON.stringify(cases.at(-1)))
}
const retryPolicy = { mode: 'normal' as const, maxRetries: 0 }
const runtime = createDecisionRuntime({ timeoutMs: 60_000, retryPolicy, providers: [
  ...(typesafeKey ? [typesafePlugin({ apiKey: typesafeKey, requestTimeoutMs: 60_000 })] : []),
  ...(openaiKey ? (['json-schema', 'tool'] as const).map(outputMode => llmDecisionPlugin({ id: `openai-${outputMode}`, routes: [`openai-${outputMode}`], adapter: openAiAdapter({ apiKey: openaiKey, requestTimeoutMs: 60_000, retryPolicy }), outputMode, generation: { maxTokens: 512 } })) : []),
  ...(openaiKey ? [llmDecisionPlugin({ id: 'openai-evidence', routes: ['openai-evidence'], adapter: openAiAdapter({ apiKey: openaiKey, requestTimeoutMs: 60_000, retryPolicy }), evidence: 'model-generated', generation: { maxTokens: 1_024 } })] : []),
] })
try {
  for (const provider of ['typesafe', 'openai-json-schema', 'openai-tool'] as const) {
    if (process.env.DECISION_SMOKE_FOCUS && provider !== process.env.DECISION_SMOKE_FOCUS) continue
    if (!(provider === 'typesafe' ? typesafeKey : openaiKey)) {
      cases.push({ name: provider, status: 'skipped', code: 'KEY_NOT_CONFIGURED' })
      console.log(JSON.stringify(cases.at(-1)))
      continue
    }
    const task = createDecisionTask(runtime.decisionModel({ provider, model: provider === 'typesafe' ? typesafeModel : openaiModel }), { questions })
    for (const [index, state] of states.entries()) {
      await probe(`${provider}/${index === 0 ? 'en' : 'vi'}`, async () => {
        const result = await task.evaluate(state, {}, { providerOptions: { headers: { 'x-sdk-decision-smoke': 'quality' } } })
        assertAnswer(result, provider === 'typesafe')
        return { model: result.model, usage: result.usage }
      })
    }
    for (const [department, state] of [
      ['technical', 'Our production application is completely down. Please investigate and restore service immediately. We are not requesting a refund.'],
      ['sales', 'We want to purchase 20 new licenses. Please send pricing and a quote. We are not requesting a refund.'],
    ] as const) {
      await probe(`${provider}/${department}-no-refund`, async () => {
        const result = await task.evaluate(state)
        assertAnswer(result, provider === 'typesafe', department, false)
        return { model: result.model, usage: result.usage }
      })
    }
    await probe(`${provider}/batch`, async () => {
      const rows = await task.evaluateBatch(states, { concurrency: 2, timeoutMs: 60_000 })
      for (const row of rows) {
        if (row.status !== 'fulfilled') throw row.reason
        assertAnswer(row.value, provider === 'typesafe')
      }
      return { usage: rows.map(row => row.status === 'fulfilled' ? row.value.usage : undefined) }
    })
  }
  if (openaiKey && (!process.env.DECISION_SMOKE_FOCUS || process.env.DECISION_SMOKE_FOCUS === 'openai-evidence')) await probe('openai/model-generated-evidence', async () => {
    const result = await runtime.decisionModel({ provider: 'openai-evidence', model: openaiModel }).evaluate({ state: states[0], questions })
    assertAnswer(result)
    if (result.answers.department.probabilitySource !== 'model-generated' || gateChoice(result.answers.department, { minProbability: 0.8 }).status !== 'abstained') throw new ModelError('Evidence provenance contract failed', 'ACCEPTANCE_FAILED')
    return { model: result.model, usage: result.usage }
  })
  if (openaiKey && typesafeKey && !process.env.DECISION_SMOKE_FOCUS) await probe('core/openai-tool-typesafe', async () => {
    const task = createDecisionTask(runtime.decisionModel({ provider: 'typesafe', model: typesafeModel }), { questions })
    let toolRuns = 0
    const core = await createAgentRuntime({ providers: [openAiPlugin({ apiKey: openaiKey, defaultModel: openaiModel, requestTimeoutMs: 60_000, retryPolicy })] })
    try {
      const tool = defineTool<{ message: string }>({ name: 'classify_ticket', description: 'Classify a customer ticket into the right department.',
        parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
        parse(raw) { if (raw === null || typeof raw !== 'object' || !('message' in raw) || typeof raw.message !== 'string') throw new Error('message required'); return { message: raw.message } },
        async execute(args, ctx) {
          toolRuns++
          const result = await task.evaluate(args.message, { signal: ctx.signal }, { ...(ctx.logger ? { logger: ctx.logger } : {}) })
          assertAnswer(result, true)
          return { department: result.answers.department.choice }
        },
      })
      const result = await core.agent({ id: 'decision-live', instructions: 'Call classify_ticket exactly once using the customer message. Then reply with only the department returned by that tool.', tools: [tool], compaction: false }).generate(states[0])
      const text = result.message?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
      if (toolRuns !== 1 || !text.toLowerCase().includes('billing')) throw new ModelError('Core tool integration failed', 'ACCEPTANCE_FAILED')
      return { model: openaiModel }
    } finally { await core.close() }
  })
} finally {
  await runtime.close()
  console.log(JSON.stringify({ summary: { passed: cases.filter(row => row.status === 'passed').length, failed: cases.filter(row => row.status === 'failed').length, skipped: cases.filter(row => row.status === 'skipped').length } }))
}
