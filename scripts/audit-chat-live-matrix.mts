import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StoredNode } from '../samples/chat-agents/backend/src/event-projection.ts'
import type { WireEvent } from '../samples/chat-agents/backend/src/wire.ts'
import { assessLiveMatrixRun } from '../tests/helpers/live-matrix-checks.ts'

const directory = resolve(process.argv[2] ?? (() => { throw new Error('Pass the live-matrix artifact directory') })())
const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8')) as { root: string; model: string }
const db = new DatabaseSync(join(summary.root, 'app.db'), { readOnly: true })
try {
  const files = readdirSync(directory)
  const ids = [...new Set(files.filter(name => /^(research|coding|analysis)-.*\.json$/.test(name)).map(name => name.replace(/(-failure)?\.json$/, '')))]
  const runs = ids.map(id => {
      const name = files.includes(`${id}.json`) ? `${id}.json` : `${id}-failure.json`
      const run = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { id: string; effort: string; durationMs: number; events: WireEvent[]; checks?: { fixturePassed?: boolean } }
      const rows = db.prepare('select payload from messages where conversation_id = ? order by seq').all(run.id) as { payload: string }[]
      const nodes = rows.map(row => JSON.parse(row.payload) as StoredNode)
      const checks = { ...assessLiveMatrixRun(run.id.split('-')[0]!, nodes, run.events),
        runRecorded: !name.endsWith('-failure.json'),
        ...(run.checks?.fixturePassed === undefined ? {} : { fixturePassed: run.checks.fixturePassed }),
      }
      const closeIds = new Set(run.events.filter(e => e.t === 'tool-call' && e.name === 'close_agent').map(e => 'id' in e ? e.id : ''))
      const protectedClosures = run.events.filter(e => {
        if (e.t !== 'tool-result' || !closeIds.has(e.id)) return false
        try { return (JSON.parse(e.output) as { closed?: boolean }).closed === false } catch { return false }
      }).length
      const usage = db.prepare('select count(*) as calls, sum(case when member is null then 1 else 0 end) as leadCalls, sum(input_tokens) as freshInputTokens, sum(cache_read_tokens) as cachedInputTokens, sum(output_tokens) as outputTokens from usage_events where conversation_id = ?').get(run.id)
      const leadFinalResponses = nodes.filter(n => n.kind === 'text' && n.member === undefined && n.phase === 'final-answer').length
      return { id: run.id, durationMs: run.durationMs, checks, protectedClosures, leadFinalResponses, usage, passed: Object.values(checks).every(Boolean) }
    })
  const report = { model: summary.model, count: runs.length, passed: runs.filter(r => r.passed).length, runs }
  writeFileSync(join(directory, 'audit.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ model: report.model, count: report.count, passed: report.passed,
    failures: runs.filter(run => !run.passed),
  }, null, 2))
} finally { db.close() }
