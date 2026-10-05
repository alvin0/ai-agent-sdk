import { booleanQuestion, choiceQuestion, createDecisionRuntime, createDecisionTask, gateBoolean, gateChoice, scoreQuestion } from '@alvin0/ai-agent-sdk-decision-adapter'
import { typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe'

const apiKey = process.env.TYPESAFE_API_KEY
if (!apiKey) throw new Error('Set TYPESAFE_API_KEY in .env before running pnpm human:decision')
const runtime = createDecisionRuntime({ providers: [typesafePlugin({ apiKey, retryPolicy: { mode: 'normal', maxRetries: 1 } })] })
const model = runtime.decisionModel({ provider: 'typesafe', model: process.env.TYPESAFE_MODEL ?? 'jev-latest' })
const task = createDecisionTask(model, { questions: {
  department: choiceQuestion('Which department should handle this request?', { billing: 'Invoices, payments, refunds', technical: 'Software bugs, outages', sales: 'New purchases, pricing' }),
  urgency: scoreQuestion('How urgent is this request?', ['Routine; no time constraint', 'Time-sensitive; needs help today', 'Critical emergency; immediate action required']),
  refund: booleanQuestion('Is the customer asking for a refund?'),
} })
try {
  for (const [language, state] of [
    ['en', 'I was charged twice for the same invoice. Please refund the duplicate charge today.'],
    ['vi', 'Tôi bị trừ tiền hai lần cho cùng một hóa đơn. Vui lòng hoàn lại khoản thu trùng trong hôm nay.'],
  ] as const) {
    const started = performance.now()
    const result = await task.evaluate(state)
    const department = gateChoice(result.answers.department, { minProbability: 0.8, minMargin: 0.2 })
    const refund = gateBoolean(result.answers.refund, { falseMax: 0.2, trueMin: 0.8 })
    if (department.status !== 'accepted' || department.value !== 'billing' || refund.status !== 'accepted' || !refund.value) throw new Error(`Decision acceptance failed for ${language}`)
    console.log(JSON.stringify({ language, latencyMs: Math.round(performance.now() - started), ...result }, null, 2))
  }
} catch (error) {
  // Print code-only diagnostics; neither arbitrary provider text nor credentials.
  console.error('TypeSafe live acceptance failed', { code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'ACCEPTANCE_FAILED' })
  process.exitCode = 1
} finally {
  await runtime.close()
}
