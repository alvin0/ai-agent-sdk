import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ModelRegistry } from '@ai-agent-sdk/core'
import { codexNodeAdapter } from '@ai-agent-sdk/auth-node/codex'
import type { StoredNode } from '../../samples/chat-agents/backend/src/event-projection.ts'
import type { WireEvent } from '../../samples/chat-agents/backend/src/wire.ts'

// Opt-in integration test: real model usage and public web reads, isolated app data.
const root = mkdtempSync(join(tmpdir(), 'chat-market-live-'))
process.env.CHAT_AGENTS_DB = join(root, 'app.db')
process.env.CHAT_AGENTS_WORKSPACE = join(root, 'workspace')
process.env.CHAT_AGENTS_SPILL = join(root, 'spill')
process.env.CHAT_AGENTS_MIGRATIONS = resolve('samples/chat-agents/backend/drizzle')
delete process.env.CHAT_AGENTS_MOCK_MODEL
const model = process.env.CHAT_AGENTS_LIVE_MODEL ?? 'gpt-reserve'
const output = resolve('samples/chat-agents/.data/live-market', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'run-info.json'), JSON.stringify({ root, model, startedAt: new Date().toISOString() }, null, 2))
const { runPrompt, forgetSession, approve, answer, abortRun } = await import('../../samples/chat-agents/backend/src/session.ts')
const { ensureConversation, updateConversation, readMessages } = await import('../../samples/chat-agents/backend/src/conversations.ts')
const registry = new ModelRegistry()
registry.registerAdapter(['codex'], codexNodeAdapter())

describe('Team-auto live stock research', () => {
  it.each(['medium', 'high', 'max'])('%s', async effort => {
    const catalogue = await registry.listModels('codex')
    expect(catalogue.some(entry => entry.id === model), 'require exact catalogued model').toBe(true)
    const info = await registry.resolveModelInfo('codex', model)
    expect(info.reasoning?.efforts.map(e => String(e.id))).toContain(effort)
    const id = `market-${effort}`
    const workspace = join(root, id)
    mkdirSync(workspace, { recursive: true })
    await ensureConversation(id, { mode: 'team-dynamic', workspaceRoot: workspace, groupId: 'default' })
    await updateConversation(id, { provider: 'codex', model, reasoningEffort: effort, mode: 'team-dynamic' })
    const prompt = 'Tổng hợp cho tôi giá các cổ phiếu tăng giá tốt và có tiềm năng trong tháng 9 và 10 2026, có thể sử dụng multiple agent chia thành nhiều lĩnh vực để research hiệu quả hơn'
      + '\nPhạm vi kiểm tra: thị trường Việt Nam, ngày tham chiếu 2026-09-08. Dùng đúng hai worker chia ngành. Chỉ đọc nguồn công khai bằng các tool được cung cấp; không chạy lệnh, cài package hay sửa file.'
      + ' Công bố và đối soát todo. Worker phải gửi báo cáo cuối; lead tổng hợp một câu trả lời bằng tiếng Việt, tối đa 700 từ.'
      + ' Giá phải kèm ngày và nguồn; tách dữ liệu quan sát khỏi dự báo tháng 10. Nếu không xác minh được dữ liệu thì nói rõ, không tự tạo giá. Không cần hỏi thêm.'
    const events: WireEvent[] = []
    const start = Date.now()
    let deadlineReached = false
    // This is the test watchdog, not the SDK auto policy. Match the existing
    // live matrix's longer allowance for max-effort team research.
    const timer = setTimeout(() => { deadlineReached = true; void abortRun(id) }, effort === 'max' ? 900_000 : 600_000)
    let nodes: readonly StoredNode[] = []
    try {
      for await (const event of runPrompt(id, prompt, 'default')) {
        if (event.t !== 'reasoning-delta') events.push(event)
        if (['tool-call', 'tool-result', 'member-end', 'run-end', 'error'].includes(event.t)) {
          appendFileSync(join(output, 'progress.jsonl'), JSON.stringify({ id, elapsedMs: Date.now() - start,
            event: event.t, ...'name' in event ? { name: event.name } : {},
            ...'member' in event ? { member: event.member } : {},
          }) + '\n')
        }
        if (event.t === 'approval') await approve(id, event.callId, 'deny', 'once')
        if (event.t === 'question') await answer(id, event.requestId,
          Object.fromEntries(event.questions.map(q => [q.id, 'Thị trường Việt Nam; dùng nguồn công khai, nêu rõ dữ liệu chưa xác minh được.'])))
      }
      nodes = await readMessages(id) as readonly StoredNode[]
      const texts = nodes.filter((n): n is Extract<StoredNode, { kind: 'text' }> => n.kind === 'text')
      const final = texts.findLast(n => n.member === undefined && n.phase === 'final-answer')
      const workers = new Set(texts.filter(n => n.member !== undefined && n.phase === 'final-answer'
        && n.text.trim().length >= 40).map(n => n.member))
      const lastWorkerReport = nodes.findLastIndex(n => n.kind === 'text' && n.member !== undefined && n.phase === 'final-answer')
      const plans = new Map<string, Extract<StoredNode, { kind: 'tool' }>['card']>()
      for (const node of nodes) if (node.kind === 'tool' && node.name === 'write_todos' && node.state === 'ok') {
        plans.set(node.member ?? 'lead', node.card)
      }
      const warnings = events.filter(e => e.t === 'notice' && e.level === 'warn')
      const checks = {
        finalReport: (final?.text.trim().length ?? 0) >= 100 && final?.incomplete !== true,
        leadSynthesizedAfterWorkers: final !== undefined && nodes.indexOf(final) > lastWorkerReport,
        workerReports: workers.size === 2,
        leadPlan: plans.get('lead')?.kind === 'todo',
        webAttempted: events.some(e => e.t === 'tool-call' && e.name === 'fetch_url'),
        noRunError: !events.some(e => e.t === 'error'),
        finishedInTime: !deadlineReached,
      }
      writeFileSync(join(output, `${id}.json`), JSON.stringify({ model, effort, prompt, durationMs: Date.now() - start,
        checks, final: final?.text,
        review: {
          // A valid partial report must not masquerade as complete research.
          // Keep these facts beside lifecycle checks for human evidence review.
          deliveryChecksPassed: Object.values(checks).every(Boolean),
          // Delivery can pass with partial workers. Do not label lifecycle
          // success as completed research or independently verified prices.
          noWorkerWarnings: !warnings.some(e => e.t === 'notice' && e.member !== undefined),
          allPublishedPlansDone: plans.size > 0 && [...plans.values()].every(card =>
            card?.kind === 'todo' && card.items.length > 0 && card.items.every(item => item.status === 'done')),
          priceAccuracy: 'requires-independent-source-review',
          warnings,
          failedTools: nodes.filter(n => n.kind === 'tool' && n.state === 'error').length,
          latestPlans: Object.fromEntries(plans),
        },
        nodes: nodes.filter(n => n.kind !== 'reasoning'), events }, null, 2))
      console.log(JSON.stringify({ output, id, checks }))
      // These assertions cover lifecycle only. Price/source accuracy needs a
      // separate evidence review of the retained report, never a guessed oracle.
      expect(Object.values(checks).every(Boolean)).toBe(true)
    } finally {
      clearTimeout(timer)
      await abortRun(id)
      forgetSession(id)
      writeFileSync(join(output, `${id}-events.json`), JSON.stringify({ model, effort, deadlineReached, events }, null, 2))
    }
  }, 960_000)
})
