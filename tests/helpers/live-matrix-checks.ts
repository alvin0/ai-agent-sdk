import type { StoredNode } from '../../samples/chat-agents/backend/src/event-projection.ts'
import type { WireEvent } from '../../samples/chat-agents/backend/src/wire.ts'

/** Validate content and lifecycle separately; English month names and ISO dates
 * represent the same observation. A formatted currency must not hide bad math. */
export function assessLiveMatrixRun(topic: string, nodes: readonly StoredNode[], events: readonly WireEvent[]) {
  const texts = nodes.filter((n): n is Extract<StoredNode, { kind: 'text' }> => n.kind === 'text')
  const final = texts.at(-1)
  const body = final?.text ?? ''
  const finalWorkers = new Set(texts.filter(n => n.member !== undefined && n.phase !== 'commentary' && n.text.trim().length >= 40).map(n => n.member))
  const lastTodo = nodes.findLast(n => n.kind === 'tool' && n.name === 'write_todos' && n.member === undefined)
  const plan = lastTodo?.kind === 'tool' && lastTodo.card?.kind === 'todo' ? lastTodo.card.items : []
  const numeric = body.replace(/[*_,]/g, '')
  return {
    leadLast: final !== undefined && final.member === undefined && final.phase !== 'commentary',
    substantive: body.length >= 80,
    // These bounded fixture tasks may have a draft and a synthesis, but must
    // not rewrite their conclusion through an entire 48-step lead turn.
    noConclusionLoop: texts.filter(n => n.member === undefined && n.phase === 'final-answer').length <= 3,
    workerReports: finalWorkers.size >= 2,
    plan: plan.length > 0,
    planReconciled: plan.length > 0 && plan.every(item => item.status === 'done'),
    noRunError: !events.some(e => e.t === 'error'),
    evidence: topic === 'research'
      ? /\b120\b/.test(numeric) && /\b150\b/.test(numeric)
        && /2026-10|October\s+2026/i.test(body) && /forecast|unverified/i.test(body)
      : topic === 'analysis'
        ? /\b340(?:\.00)?\b/.test(numeric) && /USD|\$/.test(body)
          && /duplicat\w*[^.\n]{0,80}\bb\b|\bb\b[^.\n]{0,80}duplicat/i.test(numeric)
          && /missing[^.\n]{0,80}\bc\b|\bc\b[^.\n]{0,80}missing/i.test(numeric)
        : /cursor/i.test(body) && /test|verif/i.test(body),
  }
}
