/**
 * SPIKE A — history substrate: append-only log vs `Message[]` + splice.
 *
 * Settles open decision #1 in `docs/tool-loop-design.md` by building BOTH and
 * running the same three scenarios against each, instead of arguing about them.
 *
 * Run: `node spikes/history-substrate.ts`
 *
 * The three scenarios are the only reasons the design doc claims a log is needed.
 * If the array passes all three, the log is unjustified complexity and the doc is
 * wrong. That is a real possible outcome of this spike.
 */

import {
  createAssistantMessage,
  createTextMessage,
  createToolResultMessage,
  type Message,
} from '@ai-agent-sdk/core'
import { ToolCallId } from '@ai-agent-sdk/core'

// ─────────────────────────────────────────────────────────────────────────────
// Implementation 1: plain Message[] with a splice for compaction
// ─────────────────────────────────────────────────────────────────────────────

class ArrayHistory {
  private msgs: Message[] = []

  append(message: Message): void {
    this.msgs.push(message)
  }

  /** Compaction: replace a span with a summary. */
  compact(from: number, to: number, summary: Message): void {
    this.msgs.splice(from, to - from, summary)
  }

  /** What the model sees. */
  messages(): readonly Message[] {
    return this.msgs
  }

  /** What a human sees. Identical by construction — which is the whole question. */
  transcript(): readonly Message[] {
    return this.msgs
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation 2: append-only log + pure projection
// ─────────────────────────────────────────────────────────────────────────────

type SurfaceOp = 'append' | { op: 'replace'; from: number; to: number }

interface Entry {
  seq: number
  kind: 'user' | 'assistant' | 'tool-call' | 'tool-result'
  message?: Message
  callId?: string
  toolName?: string
  surfaceOp: SurfaceOp
}

class LogHistory {
  private log: Entry[] = []
  private seq = 0

  append(kind: Entry['kind'], payload: Omit<Entry, 'seq' | 'kind' | 'surfaceOp'>, surfaceOp: SurfaceOp = 'append'): number {
    const seq = this.seq++
    this.log.push({ seq, kind, ...payload, surfaceOp })
    return seq
  }

  /** Compaction: append a summary that SHADOWS a span. Nothing is removed. */
  compact(fromSeq: number, toSeq: number, summary: Message): void {
    this.append('user', { message: summary }, { op: 'replace', from: fromSeq, to: toSeq })
  }

  /** Pure projection: what the model sees, after replacements. */
  messages(): readonly Message[] {
    const shadowed = new Set<number>()
    for (const entry of this.log) {
      if (typeof entry.surfaceOp === 'object') {
        for (let s = entry.surfaceOp.from; s <= entry.surfaceOp.to; s++) shadowed.add(s)
      }
    }
    return this.log
      .filter(entry => !shadowed.has(entry.seq))
      // A tool-call entry is logged but NOT model-visible: the assistant message
      // already carries the call, so projecting it would duplicate it.
      .filter(entry => entry.kind !== 'tool-call')
      .map(entry => entry.message)
      .filter((message): message is Message => message !== undefined)
  }

  /** What a human sees: everything that ever happened. */
  transcript(): readonly Entry[] {
    return this.log
  }

  /** Orphan detection: a logged call with no logged result. */
  orphanedCalls(): readonly { callId: string; toolName: string }[] {
    const answered = new Set(
      this.log.filter(e => e.kind === 'tool-result').map(e => e.callId),
    )
    return this.log
      .filter(e => e.kind === 'tool-call' && !answered.has(e.callId))
      .map(e => ({ callId: e.callId ?? '', toolName: e.toolName ?? '' }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

interface Verdict {
  scenario: string
  array: string
  log: string
}

/** S1 — compaction must shrink the request WITHOUT editing the human transcript. */
function scenarioCompaction(): Verdict {
  const chatter = Array.from({ length: 8 }, (_, i) => createTextMessage(`turn ${i}`))
  const summary = createTextMessage('[summary of turns 1-6]')

  const array = new ArrayHistory()
  for (const m of chatter) array.append(m)
  const arrayBefore = array.transcript().length
  array.compact(1, 7, summary)

  const log = new LogHistory()
  const seqs = chatter.map(m => log.append('user', { message: m }))
  const logBefore = log.transcript().length
  log.compact(seqs[1] ?? 0, seqs[6] ?? 0, summary)

  const arrayKeptTranscript = array.transcript().length === arrayBefore
  const logKeptTranscript = log.transcript().length > logBefore

  return {
    scenario: 'S1 compaction shrinks request, transcript intact',
    array: `request ${array.messages().length} msgs; transcript ${arrayKeptTranscript ? 'INTACT' : `LOST ${arrayBefore - array.transcript().length} msgs`}`,
    log: `request ${log.messages().length} msgs; transcript ${logKeptTranscript ? 'INTACT (grew)' : 'LOST'}`,
  }
}

/** S2 — a crash left a tool call unanswered; the next request must still be valid. */
function scenarioInterruptRepair(): Verdict {
  const callA = ToolCallId('call_a')
  const callB = ToolCallId('call_b')
  const assistant = createAssistantMessage({
    content: [
      { type: 'tool-call', id: callA, name: 'read_file', arguments: '{"p":"a"}' },
      { type: 'tool-call', id: callB, name: 'read_file', arguments: '{"p":"b"}' },
    ],
    source: { provider: 'p', model: 'm' },
  })
  const resultA = createToolResultMessage({
    callId: callA,
    content: [{ type: 'text', text: 'contents of a' }],
    isError: false,
  })

  // Array: only messages exist, so "which call is unanswered" must be recovered by
  // walking assistant content and cross-referencing tool-result messages.
  const array = new ArrayHistory()
  array.append(createTextMessage('read both files'))
  array.append(assistant)
  array.append(resultA)
  const arrayCalls = array.messages()
    .flatMap(m => m.content)
    .filter(b => b.type === 'tool-call')
    .map(b => (b.type === 'tool-call' ? b.id : ''))
  const arrayAnswered = new Set(
    array.messages()
      .flatMap(m => m.content)
      .filter(b => b.type === 'tool-result')
      .map(b => (b.type === 'tool-result' ? b.toolCallId : '')),
  )
  const arrayOrphans = arrayCalls.filter(id => !arrayAnswered.has(id))

  const log = new LogHistory()
  log.append('user', { message: createTextMessage('read both files') })
  log.append('assistant', { message: assistant })
  log.append('tool-call', { callId: callA, toolName: 'read_file' })
  log.append('tool-call', { callId: callB, toolName: 'read_file' })
  log.append('tool-result', { callId: callA, message: resultA })
  const logOrphans = log.orphanedCalls()

  return {
    scenario: 'S2 detect an unanswered tool call after a crash',
    array: `found ${arrayOrphans.length} orphan(s) by scanning message content`,
    log: `found ${logOrphans.length} orphan(s), with tool name (${logOrphans.map(o => o.toolName).join(',')})`,
  }
}

/** S3 — after compaction, reconstruct exactly what was sent at an earlier step. */
function scenarioAudit(): Verdict {
  const chatter = Array.from({ length: 5 }, (_, i) => createTextMessage(`m${i}`))

  const array = new ArrayHistory()
  for (const m of chatter) array.append(m)
  const arrayAtStep2 = array.messages().length
  array.compact(0, 3, createTextMessage('[summary]'))

  const log = new LogHistory()
  const seqs = chatter.map(m => log.append('user', { message: m }))
  const logSnapshotSeq = seqs[4] ?? 0
  log.compact(seqs[0] ?? 0, seqs[2] ?? 0, createTextMessage('[summary]'))
  // Replay the projection over the log prefix as it stood before compaction.
  const prefix = log.transcript().filter(e => e.seq <= logSnapshotSeq)
  const reconstructed = prefix.filter(e => e.kind !== 'tool-call').length

  return {
    scenario: 'S3 reconstruct the pre-compaction request',
    array: arrayAtStep2 === array.messages().length
      ? `reconstructed ${arrayAtStep2}`
      : `IMPOSSIBLE (was ${arrayAtStep2}, now ${array.messages().length}, originals gone)`,
    log: `reconstructed ${reconstructed} from log prefix`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const verdicts = [scenarioCompaction(), scenarioInterruptRepair(), scenarioAudit()]

console.log('\nSPIKE A — history substrate\n')
for (const v of verdicts) {
  console.log(`  ${v.scenario}`)
  console.log(`    Message[]+splice : ${v.array}`)
  console.log(`    append-only log  : ${v.log}\n`)
}

// Cost side of the comparison, so the verdict is not benefit-only.
const arrayLoc = 18
const logLoc = 46
console.log(`  cost: ArrayHistory ~${arrayLoc} lines, LogHistory ~${logLoc} lines`
  + ` (+${logLoc - arrayLoc})\n`)
