import { runProviderConformanceSuite } from '@alvin0/ai-agent-sdk-testkit'
import { independentProviderFixture } from '@fixture/independent-provider'

const report = await runProviderConformanceSuite(independentProviderFixture, { caseTimeoutMs: 1_000 })
if (report.status !== 'passed' || report.passed !== 19 || report.failed !== 0) {
  throw new Error('installed provider conformance report is incomplete')
}
process.stdout.write(`${JSON.stringify(report)}\n`)
