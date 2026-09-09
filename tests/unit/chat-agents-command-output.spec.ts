import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'cmd-output-'))
const { createSampleTools, onCommandOutput } =
  await import('../../samples/chat-agents/backend/src/tools.ts')

const tools = createSampleTools(root)
const run = tools.get('run_command')!

/** Run a command, recording output as it arrives and when it arrived. */
async function watched(command: string, callId: string) {
  const chunks: { at: number; text: string }[] = []
  const stop = onCommandOutput((id, text) => {
    if (id === callId) chunks.push({ at: Date.now(), text })
  })
  try {
    const started = Date.now()
    const result = await run.execute!(
      { command, cwd: '.', timeoutMs: 30_000 } as never,
      { callId, toolName: 'run_command' } as never,
    ) as { output: string; exitCode: number }
    return { chunks, result, started, finished: Date.now() }
  } finally { stop() }
}

describe('live command output', () => {
  it('arrives before the command exits', async () => {
    // Prints, waits, prints again: a chunk timestamped well before the exit is
    // the only proof that the UI does not have to wait for the process.
    // Double quotes outside, single inside: cmd.exe does not treat a single
    // quote as a quote at all, so the other way round is not a command.
    const script = "console.log('first'); setTimeout(() => console.log('second'), 700)"
    const { chunks, result, finished } = await watched(`node -e "${script}"`, 'call_stream')

    expect(result.exitCode).toBe(0)
    expect(chunks.length).toBeGreaterThan(0)
    const first = chunks[0]
    expect(first?.text).toContain('first')
    expect(finished - (first?.at ?? 0)).toBeGreaterThan(400)
    // And nothing is lost: the streamed pieces reconstruct the settled output.
    expect(chunks.map(chunk => chunk.text).join('')).toBe(result.output)
  })

  it('flushes the last burst even though its timer had not fired', async () => {
    // A command that prints once and exits immediately would otherwise lose
    // that line to the coalescing timer.
    const { chunks, result } = await watched('node -e "console.log(3)"', 'call_tail')
    expect(chunks.map(chunk => chunk.text).join('')).toBe(result.output)
    expect(result.output).toContain('3')
  })

  it('reports output only to the call that produced it', async () => {
    const seen: string[] = []
    const stop = onCommandOutput((id) => { seen.push(id) })
    try {
      await run.execute!(
        { command: 'node -e "console.log(1)"', cwd: '.', timeoutMs: 30_000 } as never,
        { callId: 'call_mine', toolName: 'run_command' } as never,
      )
    } finally { stop() }
    // Every chunk carries its own call id, which is how one conversation's
    // build avoids being narrated into another's transcript.
    expect(new Set(seen)).toEqual(new Set(['call_mine']))
  })

  it('stops reporting once unsubscribed', async () => {
    let count = 0
    const stop = onCommandOutput(() => { count += 1 })
    stop()
    await run.execute!(
      { command: 'node -e "console.log(2)"', cwd: '.', timeoutMs: 30_000 } as never,
      { callId: 'call_gone', toolName: 'run_command' } as never,
    )
    expect(count).toBe(0)
  })
})
