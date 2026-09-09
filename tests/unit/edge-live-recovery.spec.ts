import { describe, expect, it } from 'vitest'
import {
  fallbackRunId, readOption, researchFallbackReason, setOption,
} from '../../test-human/edge-chat/live/recovery.ts'

describe('Edge live native-search recovery', () => {
  it('retries only a failed native-search acceptance', () => {
    expect(researchFallbackReason({ status: 'failed', invariants: [
      { name: 'Agent performs at least three provider-native searches', passed: false },
    ] })).toBe('provider-native-search-acceptance-missing')
    expect(researchFallbackReason({ status: 'failed', invariants: [
      { name: 'Authenticated provider runs inside strict workerd', passed: false },
      { name: 'Agent performs at least three provider-native searches', passed: false },
    ] })).toBeUndefined()
    expect(researchFallbackReason({ status: 'passed', invariants: [
      { name: 'Agent performs at least three provider-native searches', passed: false },
    ] })).toBeUndefined()
  })

  it('recovers an incomplete research run when infrastructure remained healthy', () => {
    expect(researchFallbackReason({ status: 'failed', invariants: [
      { name: 'Authenticated provider runs inside strict workerd', passed: true },
      { name: 'Test-only relay performs bounded real upstream transport', passed: true },
      { name: 'SSE has one support-safe terminal event', passed: true },
      { name: 'Browser displays live agent/tool process', passed: true },
      { name: 'Browser coalesces streamed commentary into readable progress rows', passed: true },
      { name: 'Browser keeps the completed Markdown report in the message viewport', passed: true },
      { name: 'Every model call reports authoritative usage', passed: true },
      { name: 'Credential never appears in SSE or artifacts', passed: true },
      { name: 'Runtime closes without unsettled work', passed: true },
      { name: 'Browser emits no console/page error', passed: true },
      { name: 'Agent performs at least three provider-native searches', passed: true },
      { name: 'Agent submits provenance audit after reading', passed: false },
    ] })).toBe('research-acceptance-incomplete')
  })

  it('does not switch models to hide a browser presentation failure', () => {
    expect(researchFallbackReason({ status: 'failed', invariants: [
      { name: 'Browser coalesces streamed commentary into readable progress rows', passed: false },
      { name: 'Agent submits provenance audit after reading', passed: false },
    ] })).toBeUndefined()
  })

  it('builds bounded run ids and replaces runner options', () => {
    expect(fallbackRunId('primary', 'vendor:model/name')).toBe('primary-fallback-vendor-model-name')
    const args = setOption(['--model', 'first', '--headful'], '--model', 'fallback')
    expect(args).toEqual(['--headful', '--model', 'fallback'])
    expect(readOption(args, '--model')).toBe('fallback')
  })
})
