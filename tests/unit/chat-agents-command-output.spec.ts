import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'cmd-output-'))
const { createSampleTools, onCommandOutput } =
  await import('../../samples/chat-agents/backend/src/tools.ts')

const tools = createSampleTools(root)
const run = tools.get('run_command')!

/** Run a command, recording output as it arrives and when it arrived. */
async function watched(command: string, callId: string, onChunk?: (text: string) => void) {
  const chunks: { at: number; text: string }[] = []
  const stop = onCommandOutput((id, text) => {
    if (id === callId) { chunks.push({ at: Date.now(), text }); onChunk?.(text) }
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
  it('preserves UTF-8 characters split across pipe chunks', async () => {
    const script = "process.stdout.write(Buffer.from([0xe2]));setTimeout(()=>process.stdout.write(Buffer.from([0x82,0xac])),40)"
    const { chunks, result } = await watched(`node -e "${script}"`, 'call_unicode')
    expect(result.output).toBe('€')
    expect(chunks.map(chunk => chunk.text).join('')).toBe('€')
  })

  it('caps live output as well as the settled capture', async () => {
    const { chunks, result } = await watched('node -e "process.stdout.write(\'x\'.repeat(1000000))"', 'call_cap')
    const streamed = chunks.map(chunk => chunk.text).join('')
    expect(streamed.length).toBe(20_000)
    expect(result.output).toBe(streamed + '\n[output truncated at 20000 characters; narrow the command (grep, head, wc) to see the rest]')
  })

  it('arrives before the command exits', async () => {
    // The child cannot finish until the observer acknowledges its first chunk.
    // This proves streaming without a wall-clock margin sensitive to CPU load.
    // Double quotes outside, single inside: cmd.exe does not treat a single
    // quote as a quote at all, so the other way round is not a command.
    const script = "const fs=require('fs'); console.log('first'); let waits=0; const timer=setInterval(()=>{if(fs.existsSync('stream-ack')){clearInterval(timer);console.log('second')}else if(++waits>500){process.exit(9)}},10)"
    const { chunks, result } = await watched(`node -e "${script}"`, 'call_stream', text => {
      if (text.includes('first')) writeFileSync(join(root, 'stream-ack'), 'ready')
    })

    expect(result.exitCode).toBe(0)
    expect(chunks.length).toBeGreaterThan(0)
    const first = chunks[0]
    expect(first?.text).toContain('first')
    expect(first?.text).not.toContain('second')
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
