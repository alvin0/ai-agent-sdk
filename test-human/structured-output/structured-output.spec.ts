import { describe, expect, it } from 'vitest'
import { parseStructuredOutputArgs } from './config.ts'

describe('live structured-output harness configuration', () => {
  it('selects both scenarios with bounded live defaults', () => {
    expect(parseStructuredOutputArgs(['--', '--run-id', 'fixture'])).toMatchObject({
      runId: 'fixture',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      scenario: 'all',
      longSteps: 6,
      timeoutMs: 120_000,
      verbose: false,
    })
  })

  it('accepts explicit scenario controls and rejects unsafe bounds', () => {
    expect(parseStructuredOutputArgs([
      '--scenario', 'long', '--long-steps', '12', '--timeout-ms', '300000',
      '--model', 'gpt-5.6-sol', '--verbose',
    ])).toMatchObject({
      scenario: 'long', longSteps: 12, timeoutMs: 300_000,
      model: 'gpt-5.6-sol', verbose: true,
    })
    expect(() => parseStructuredOutputArgs(['--scenario', 'unknown'])).toThrow(/all, short, or long/u)
    expect(() => parseStructuredOutputArgs(['--long-steps', '17'])).toThrow(/3 to 16/u)
    expect(() => parseStructuredOutputArgs(['--run-id', '../escape'])).toThrow(/safe path segment/u)
  })

  it('uses Gemini test environment only as a live-harness convenience', () => {
    expect(parseStructuredOutputArgs([
      '--provider', 'gemini', '--scenario', 'short', '--run-id', 'gemini-fixture',
    ], { GEMINI_MODEL: 'gemini-test-model' })).toMatchObject({
      provider: 'gemini', model: 'gemini-test-model', scenario: 'short',
    })
    expect(() => parseStructuredOutputArgs(['--provider', 'gemini'], {}))
      .toThrow(/requires --model or GEMINI_MODEL/u)
  })
})
