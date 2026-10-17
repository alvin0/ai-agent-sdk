import { describe, expect, it } from 'vitest'
import { isProgressTimer } from './progress-timers.ts'

describe('progress smoke timer classification', () => {
  const root = 'file:///repo/packages/core/dist/agent/team/'
  const caller = '    at async file:///repo/test-human/multi-agent-bench/progress-smoke.ts:50:20'
  it.each(['ManagedProgress.arm', 'a.arm', 'arm', ''])('recognizes a built progress frame (%s)', symbol => {
    const frame = `    at ${symbol} (${root}managed-progress.js:1:421)`
    expect(isProgressTimer(['    at setTimeout (node:timers:1:1)', frame, caller].join(' | '))).toBe(true)
    expect(isProgressTimer([frame, caller].join('\n'))).toBe(true)
  })
  it.each(['managed-close.js', 'team-progress-internal.js', '../loop/turn/hooks.js'])
  ('excludes %s even with the smoke script in the stack', file => {
    expect(isProgressTimer(`    at arm (${root}${file}:1:22) | ${caller}`)).toBe(false)
  })
  it('excludes host deadline and transport timers whose caller is progress-smoke', () => {
    expect(isProgressTimer('    at AbortSignal.timeout (node:internal/abort_controller:244:7) | ' + caller)).toBe(false)
    expect(isProgressTimer('    at FastTimer.refresh (node:internal/deps/undici/undici:786:11)\n' + caller)).toBe(false)
  })

})
