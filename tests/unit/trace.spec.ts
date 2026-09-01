import { describe, expect, it } from 'vitest'
import { buildTraceTree, createSpanId, createTraceId, traceparent, type TraceEvent, type TraceRef } from '../../src/agent/trace/trace.ts'

describe('agent trace', () => {
  it('uses W3C-sized ids and builds immutable parent/child process trees', () => {
    const traceId = createTraceId()
    const root: TraceRef = { traceId, spanId: createSpanId(), parentSpanId: null }
    const child: TraceRef = { traceId, spanId: createSpanId(), parentSpanId: root.spanId }
    expect(traceId).toMatch(/^[a-f0-9]{32}$/u)
    expect(root.spanId).toMatch(/^[a-f0-9]{16}$/u)
    expect(traceparent(root)).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u)
    const events: TraceEvent[] = [
      { type: 'span-start', trace: root, at: '2026-01-01T00:00:00.000Z', name: 'invoke_agent a', kind: 'invoke_agent' },
      { type: 'span-start', trace: child, at: '2026-01-01T00:00:00.010Z', name: 'chat m', kind: 'chat' },
      { type: 'span-end', trace: child, at: '2026-01-01T00:00:00.020Z', status: 'success' },
      { type: 'span-end', trace: root, at: '2026-01-01T00:00:00.030Z', status: 'success' },
    ]
    const tree = buildTraceTree(events)
    expect(tree[0]?.children[0]).toMatchObject({ parentSpanId: root.spanId, durationMs: 10 })
    expect(Object.isFrozen(tree[0]?.children)).toBe(true)
  })
})
