/**
 * The chat-agents sample, driven by real prompts against a real provider.
 *
 * Excluded from `npm test`; run with `npm run test:integration`. Needs
 * `npm run provider:codex:login-device`; without a credential the suite SKIPS.
 *
 * ## Why this exists beside the mocked suites
 *
 * `tests/unit/chat-agents-*.spec.ts` drive the same entry point with a scripted
 * adapter, which settles what the app DOES with a given stream. What they cannot
 * settle is what happens when the conversation's model or effort changes between
 * turns and a real endpoint is on the other side: whether the selection the user
 * stored is the one that runs, whether the history survives the switch, and
 * whether usage is attributed to the model that actually answered rather than
 * to the one the conversation started on.
 *
 * Answer quality is never asserted. Every claim here is about routing,
 * continuity and accounting.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { fileCodexAuthStore } from '@alvin0/ai-agent-sdk-auth-node/codex'

const PROVIDER = 'codex'
const PRIMARY_MODEL = 'gpt-5.6-luna'
const SECONDARY_MODEL = 'gpt-reserve'

const root = mkdtempSync(join(tmpdir(), 'chat-agents-live-'))
mkdirSync(join(root, 'workspace'), { recursive: true })
process.env.CHAT_AGENTS_DB = join(root, 'app.db')
process.env.CHAT_AGENTS_WORKSPACE = join(root, 'workspace')
process.env.CHAT_AGENTS_SPILL = join(root, 'spill')
process.env.CHAT_AGENTS_MIGRATIONS = resolve('samples/chat-agents/backend/drizzle')
// The scripted adapter must be off: this suite is about a real endpoint.
delete process.env.CHAT_AGENTS_MOCK_MODEL

const codexLive = await (async () => {
  const file = await fileCodexAuthStore(undefined, { cwd: process.cwd(), env: process.env }).read()
  return file?.tokens != null
})()

const { runPrompt, approve, abortRun, steer } =
  await import('../../samples/chat-agents/backend/src/session.ts')
const { ensureConversation, updateConversation, readMessages } =
  await import('../../samples/chat-agents/backend/src/conversations.ts')
const { usageSummary } = await import('../../samples/chat-agents/backend/src/usage.ts')

interface Wire { readonly t: string; readonly text?: string; readonly message?: string }

/**
 * Drive one prompt to completion, returning every wire event it produced.
 *
 * Approvals are answered as they arrive, because a parked approval holds the
 * run open on its own promise: a test that only collected events would wait
 * for a turn that can never end.
 */
async function prompt(
  id: string,
  message: string,
  decide: (event: Record<string, unknown>) => 'allow' | 'deny' = () => 'allow',
): Promise<Wire[]> {
  const events: Wire[] = []
  for await (const event of runPrompt(id, message, 'default')) {
    events.push(event as Wire)
    const record = event as unknown as Record<string, unknown>
    if (record.t === 'approval') {
      await approve(id, String(record.callId), decide(record), 'once')
    }
  }
  const failure = events.find(event => event.t === 'error')
  expect(failure?.message, `run failed: ${failure?.message ?? ''}`).toBeUndefined()
  return events
}

/** The assistant text the transcript ended up holding, newest last. */
async function transcript(id: string): Promise<string[]> {
  const nodes = await readMessages(id) as readonly { kind: string; text?: string }[]
  return nodes.flatMap(node => node.kind === 'text' && node.text !== undefined ? [node.text] : [])
}

describe.skipIf(!codexLive)('chat-agents sample, live model selection', () => {
  beforeAll(async () => {
    await ensureConversation('live-switch', { mode: 'basic', workspaceRoot: join(root, 'workspace'), groupId: 'default' })
  })

  it('runs the stored selection, keeps history across a switch, and bills the model that answered', async () => {
    await updateConversation('live-switch', {
      provider: PROVIDER, model: PRIMARY_MODEL, reasoningEffort: 'low', mode: 'basic',
    })
    await prompt('live-switch', 'Remember this codeword for later: quokka. Reply with exactly: ok')

    // The user changes both the model and the effort mid conversation, which is
    // the sample's own picker writing to the conversation row.
    await updateConversation('live-switch', {
      provider: PROVIDER, model: SECONDARY_MODEL, reasoningEffort: 'medium', mode: 'basic',
    })
    await prompt('live-switch', 'What was the codeword? Reply with the single word only.')

    const answers = await transcript('live-switch')
    // Only the earlier turn, answered by the other model, can supply this.
    expect(answers.at(-1)?.toLowerCase()).toContain('quokka')

    const usage = await usageSummary('default')
    const billed = usage.rows
      .filter(row => row.provider === PROVIDER)
      .map(row => `${row.model}:${row.effort ?? 'none'}`)
    // Both models are billed, each at the effort its own turn ran with. A
    // conversation that silently kept answering on the first model, or that
    // recorded the second turn under the first model, fails here.
    expect(billed).toContain(`${PRIMARY_MODEL}:low`)
    expect(billed).toContain(`${SECONDARY_MODEL}:medium`)
  }, 420_000)

  it('reads a real file through its own tools and answers from it', async () => {
    const workspace = join(root, 'workspace')
    writeFileSync(join(workspace, 'ledger.txt'), 'The verified total is 4211 USD.\n')
    await ensureConversation('live-tools', { mode: 'basic', workspaceRoot: workspace, groupId: 'default' })
    await updateConversation('live-tools', {
      provider: PROVIDER, model: PRIMARY_MODEL, reasoningEffort: 'low', mode: 'basic',
    })

    const events = await prompt('live-tools',
      'Read ledger.txt in this workspace and reply with the verified total, digits only. Do not guess.')

    // The claim is that the app's tool path ran, not that the model is clever:
    // a model that answered without reading has not exercised what is under test.
    expect(events.some(event => event.t === 'tool-call')).toBe(true)
    expect(events.some(event => event.t === 'tool-result')).toBe(true)
    const answers = await transcript('live-tools')
    expect(answers.at(-1)).toContain('4211')
  }, 420_000)

  it('lets a second prompt take the conversation over without splicing two dialogues', async () => {
    await ensureConversation('live-takeover', { mode: 'basic', workspaceRoot: join(root, 'workspace'), groupId: 'default' })
    await updateConversation('live-takeover', {
      provider: PROVIDER, model: PRIMARY_MODEL, reasoningEffort: 'low', mode: 'basic',
    })

    // The first run is deliberately slow to answer; the second arrives while it
    // is still in flight and must take the conversation, not run beside it.
    const first = (async () => {
      const seen: Wire[] = []
      for await (const event of runPrompt('live-takeover',
        'Count slowly from one to twenty in words, one per line.', 'default')) seen.push(event as Wire)
      return seen
    })()
    await new Promise(settle => setTimeout(settle, 1_500))
    const second = await prompt('live-takeover', 'Ignore that. Reply with exactly: taken')
    const firstEvents = await first

    expect(second.some(event => event.t === 'run-start')).toBe(true)
    // The displaced run says it is over. `runPrompt` documents that every run
    // ends with `run-end` or `error`, and a reader that waits for one of those
    // must not be left waiting because this run was replaced rather than failed.
    expect(firstEvents.at(-1)?.t).toBe('run-end')
    expect(firstEvents.some(event => event.t === 'notice')).toBe(true)
    const nodes = await readMessages('live-takeover') as readonly { kind: string; text?: string }[]
    const detail = JSON.stringify({
      firstEvents: firstEvents.map(event => event.t),
      secondEvents: second.map(event => event.t),
      nodes: nodes.map(node => [node.kind, (node.text ?? '').slice(0, 24)]),
    })
    const answers = await transcript('live-takeover')
    expect(answers.at(-1)?.toLowerCase(), detail).toContain('taken')
    await abortRun('live-takeover')
  }, 420_000)

  it('reaches the model with a message typed while it is still answering', async () => {
    await ensureConversation('live-steer', { mode: 'basic', workspaceRoot: join(root, 'workspace'), groupId: 'default' })
    await updateConversation('live-steer', {
      provider: PROVIDER, model: PRIMARY_MODEL, reasoningEffort: 'low', mode: 'basic',
    })

    const events: Wire[] = []
    let steered = false
    for await (const event of runPrompt('live-steer',
      'List the planets of the solar system, one per line, then stop.', 'default')) {
      events.push(event as Wire)
      // Typed while the answer is still streaming. Steering appends to history
      // and schedules nothing, so it is the NEXT model round of this same turn
      // that has to read it.
      if (!steered && (event as Wire).t === 'text-delta') {
        steered = await steer('live-steer', 'Change of plan: finish your reply with the word saffron.')
      }
    }
    expect(steered).toBe(true)
    expect(events.some(event => event.t === 'error')).toBe(false)
    const answers = await transcript('live-steer')
    expect(answers.join(' ').toLowerCase()).toContain('saffron')
  }, 420_000)

  it('tells the model when a mutating call was denied, and writes nothing', async () => {
    const workspace = join(root, 'workspace')
    await ensureConversation('live-deny', { mode: 'basic', workspaceRoot: workspace, groupId: 'default' })
    await updateConversation('live-deny', {
      provider: PROVIDER, model: PRIMARY_MODEL, reasoningEffort: 'low', mode: 'basic',
    })

    const events = await prompt('live-deny',
      'Create a file called forbidden.txt containing the word no. If a tool call is refused, '
      + 'stop and say exactly: refused.', () => 'deny')

    const denied = events.filter(event => event.t === 'approval')
    expect(denied.length, 'the write should have been gated at all').toBeGreaterThan(0)
    expect(existsSync(join(workspace, 'forbidden.txt'))).toBe(false)
    // A refusal has to reach the model as a result, not end the turn silently.
    const answers = await transcript('live-deny')
    expect(answers.at(-1)?.toLowerCase()).toContain('refus')
  }, 420_000)

  it('keeps what a cancelled run had, and answers the next prompt', async () => {
    await ensureConversation('live-cancel', { mode: 'basic', workspaceRoot: join(root, 'workspace'), groupId: 'default' })
    await updateConversation('live-cancel', {
      provider: PROVIDER, model: PRIMARY_MODEL, reasoningEffort: 'low', mode: 'basic',
    })

    const cancelled: Wire[] = []
    const running = (async () => {
      for await (const event of runPrompt('live-cancel',
        'Write a detailed 400 word description of the water cycle.', 'default')) {
        cancelled.push(event as Wire)
        if ((event as Wire).t === 'text-delta') void abortRun('live-cancel')
      }
    })()
    await running

    // Cancelling is the user's own doing, so it is a notice, and the stream
    // still ends with a terminal frame.
    expect(cancelled.at(-1)?.t).toBe('run-end')
    const next = await prompt('live-cancel', 'Reply with exactly: still here')
    expect(next.some(event => event.t === 'run-end')).toBe(true)
    expect((await transcript('live-cancel')).at(-1)?.toLowerCase()).toContain('still here')
  }, 420_000)

  it('accounts every live turn with disjoint, non-zero token counts', async () => {
    const usage = await usageSummary('default')
    const codex = usage.rows.filter(row => row.provider === PROVIDER)
    expect(codex.length).toBeGreaterThan(0)
    for (const row of codex) {
      expect(row.inputTokens, `${row.model} input`).toBeGreaterThan(0)
      expect(row.outputTokens, `${row.model} output`).toBeGreaterThan(0)
      // Cached input is a SUBSET of the prompt on the wire and is reported
      // separately here, so it can never exceed what was counted as input.
      expect(row.cacheReadTokens, `${row.model} cache`).toBeLessThanOrEqual(
        row.inputTokens + row.cacheReadTokens,
      )
      expect(row.calls).toBeGreaterThan(0)
    }
  }, 60_000)

  it('drops an effort the chosen model does not offer instead of losing the prompt', async () => {
    await ensureConversation('live-effort', { mode: 'basic', workspaceRoot: join(root, 'workspace'), groupId: 'default' })
    await updateConversation('live-effort', {
      provider: PROVIDER, model: PRIMARY_MODEL, reasoningEffort: 'ludicrous', mode: 'basic',
    })
    // `supportedEffort` checks the stored level against the live catalog before
    // the call, so a stale or invented level costs a downgrade, not the turn.
    const events = await prompt('live-effort', 'Reply with exactly: ok')
    expect(events.some(event => event.t === 'run-start')).toBe(true)
    const usage = await usageSummary('default')
    const row = usage.rows.find(entry => entry.model === PRIMARY_MODEL && entry.effort === null)
    expect(row, 'the turn should be billed with no effort at all').toBeDefined()
  }, 300_000)
})
