import { runMcpRoundTrips } from '../../mcp/runner.ts'
import type { SdkStressContext, SdkStressScenarioResult } from '../types.ts'
import { StressChecks } from './shared.ts'

export async function mcpConcurrencyPressure(context: SdkStressContext): Promise<SdkStressScenarioResult> {
  const checks = new StressChecks()
  const cycles = context.config.profile === 'complex' ? 2 : context.config.profile === 'stress' ? 4 : 8
  const requests = Math.max(4, Math.ceil((context.iterations * 4) / cycles))
  const result = await runMcpRoundTrips({
    requests, cycles, parallel: Math.min(32, requests), signal: context.signal,
    onCycle: cycle => context.artifact.record('mcp-cycle', cycle),
  })
  checks.equal('every MCP call reaches its expected terminal outcome', result.passed, result.requests)
  checks.check('success and remote error translation coexist under concurrency',
    result.expectedErrors > 0 && result.expectedErrors < result.requests)
  checks.check('repeated connect/initialize/list/call/close cycles leave no protocol anomalies',
    result.unexpected.length === 0, result.unexpected.slice(0, 8).join('; '))
  checks.check('every lifecycle reaches ready before close',
    result.cycles.every(cycle => cycle.lifecycle.includes('ready')))
  return Object.freeze({
    invariants: checks.items(),
    metrics: Object.freeze({
      cycles, requests: result.requests, passed: result.passed,
      expectedErrors: result.expectedErrors, parallel: Math.min(32, requests),
    }),
  })
}
