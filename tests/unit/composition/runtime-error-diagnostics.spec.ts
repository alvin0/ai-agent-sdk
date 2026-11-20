import { describe, expect, it } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import { diagnosticErrorCode } from '../../../packages/core/src/errors/diagnostic-code.ts'
import { codeOf } from '../../../packages/core/src/composition/agent/session-results.ts'
import { createUserMessage } from '../../../packages/core/src/message/message.ts'
import { safeErrorRecord } from '../../../packages/core/src/observation/event.ts'
import { messageOf } from '../../../packages/core/src/agent/define/session/common.ts'

const privateText = 'PRIVATE/ERROR~SENTINEL%'

async function fixture() {
  class Adapter extends ModelAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new Adapter()
  const runtime = await createRuntimeCompositionOwner({ providers: [{
    kind: 'model-provider-plugin', apiVersion: 1, id: 'fixture', displayName: 'Fixture',
    family: 'fixture', routes: ['fixture'], defaultModel: { provider: 'fixture', id: 'offline' },
    setup(registrar) { registrar.registerAdapter(['fixture'], adapter) },
  }] })
  const session = runtime.agent({ id: 'error-diagnostics', instructions: 'Reply', compaction: false }).createSession()
  return { runtime, session, adapter }
}

describe('runtime error diagnostics', () => {
  it('preserves a nested stable code on the thrown error and its finalized report', async () => {
    const { runtime, session } = await fixture()
    const controller = new AbortController()
    const origin = Object.assign(new Error(privateText), { code: 'BROWSER_SESSION_CLOSED' })
    try {
      const error = await session.run('go', { signal: controller.signal, onEvent(event) {
        if (event.type === 'assistant-delta') controller.abort(new Error(privateText, { cause: origin }))
      } }).catch((value: unknown) => value) as Error & { code: string; report: { status: string; errors: unknown[] } }
      expect(error.code).toBe('BROWSER_SESSION_CLOSED')
      expect(error.report.status).toBe('aborted')
      expect(error.report.errors).toContainEqual(expect.objectContaining({ code: 'BROWSER_SESSION_CLOSED' }))
      expect(JSON.stringify(error)).not.toContain(privateText)
      expect(error.message).not.toContain(privateText)
      expect(session.isRunning).toBe(false)
    } finally { await runtime.close() }
  })

  it('keeps the observer classification and exposes only its sanitized origin code', async () => {
    const { runtime, session } = await fixture()
    try {
      const error = await session.run('go', { onEvent() {
        throw new Error(privateText, { cause: Object.assign(new Error(privateText), { code: 'ECONNRESET' }) })
      } }).catch((value: unknown) => value) as Error & { code: string }
      expect(error.code).toBe('RUN_EVENT_OBSERVER_FAILED')
      expect(error.cause).toMatchObject({ code: 'ECONNRESET', message: 'Agent operation failed' })
      expect(JSON.stringify(error)).not.toContain(privateText)
      expect((error.cause as Error).stack).not.toContain(privateText)
    } finally { await runtime.close() }
  })

  it('finishes when an aborted error has a throwing code getter and cyclic cause', async () => {
    const { runtime, session } = await fixture()
    const controller = new AbortController()
    const reason = new Error(privateText)
    Object.defineProperty(reason, 'code', { get() { throw new Error(privateText) } })
    reason.cause = reason
    try {
      await expect(session.run('go', { signal: controller.signal, onEvent(event) {
        if (event.type === 'assistant-delta') controller.abort(reason)
      } })).rejects.toMatchObject({ code: 'AGENT_RUN_FAILED', report: { status: 'aborted' } })
      expect(session.isRunning).toBe(false)
    } finally { await runtime.close() }
  }, 2_000)

  it('reads stable codes from foreign records, skips generic wrappers, and contains accessors', () => {
    expect(codeOf({ code: 'BROWSER_SESSION_CLOSED' })).toBe('BROWSER_SESSION_CLOSED')
    expect(codeOf({ code: 'AGENT_RUN_FAILED', cause: { code: 'ECONNRESET' } })).toBe('ECONNRESET')
    expect(safeErrorRecord({ message: 'wrapper', code: 'AGENT_RUN_FAILED', cause: { code: 'ECONNRESET' } }))
      .toMatchObject({ code: 'ECONNRESET' })
    expect(safeErrorRecord({ message: 'wrapper', code: 'AGENT_RUN_FAILED' }))
      .toMatchObject({ code: 'AGENT_RUN_FAILED' })
    const accessor = { get code() { throw new Error(privateText) } }
    expect(codeOf(accessor)).toBe('AGENT_RUN_FAILED')
    expect(codeOf({ code: privateText })).toBe('AGENT_RUN_FAILED')
    expect(codeOf({ code: 'x'.repeat(10_000) })).toBe('AGENT_RUN_FAILED')
    const cycle: { cause?: unknown } = {}
    cycle.cause = cycle
    expect(diagnosticErrorCode(cycle)).toBeUndefined()
    let chain: unknown = { code: 'TOO_DEEP' }
    for (let index = 0; index < 16; index++) chain = { cause: chain }
    expect(diagnosticErrorCode(chain)).toBeUndefined()
  })

  it('finalizes a raw SDK boundary error with a throwing code getter', async () => {
    const { runtime, session, adapter } = await fixture()
    const reason = new Error(privateText)
    let reads = 0
    Object.defineProperty(reason, 'code', { get() { reads++; throw new Error('getter failed') } })
    adapter.resolveModel = async () => { throw reason }
    const input = createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'image', source: { kind: 'url', url: 'https://example.test/image.png' } },
    ] })
    try {
      await expect(session.run(input, { imagePolicy: 'strict' })).rejects.toMatchObject({
        code: 'AGENT_RUN_FAILED', report: { status: 'error' },
      })
      expect(session.isRunning).toBe(false)
      expect(reads).toBe(0)
    } finally { await runtime.close() }
  }, 2_000)

  it('preserves a hook failure cause without invoking its code accessor', async () => {
    const { runtime } = await fixture()
    const origin = Object.assign(new Error(privateText), { code: 'BROWSER_SESSION_CLOSED' })
    const reason = new Error(privateText, { cause: origin })
    let reads = 0
    Object.defineProperty(reason, 'code', { get() { reads++; throw new Error('getter failed') } })
    const session = runtime.agent({ id: 'hook-diagnostics', instructions: 'Reply', compaction: false })
      .createSession({ hooks: { beforeStep() { throw reason } } })
    try {
      await expect(session.run('go')).rejects.toMatchObject({
        code: 'BROWSER_SESSION_CLOSED', report: { status: 'error', errors: expect.arrayContaining([
          expect.objectContaining({ code: 'BROWSER_SESSION_CLOSED' }),
        ]) },
      })
      expect(reads).toBe(0)
      expect(session.isRunning).toBe(false)
    } finally { await runtime.close() }
  }, 2_000)

  it.each([
    ['hook', 'accessor'], ['hook', 'name-accessor'], ['hook', 'null-prototype'],
    ['modality', 'accessor'], ['modality', 'null-prototype'],
  ] as const)('preserves %s failures with %s messages', async (boundary, kind) => {
    const { runtime, session, adapter } = await fixture()
    try {
      const reason = kind === 'null-prototype'
        ? Object.assign(Object.create(null) as object, { code: 'BROWSER_SESSION_CLOSED' })
        : Object.assign(new Error(), { code: 'BROWSER_SESSION_CLOSED' })
      if (kind === 'accessor') Object.defineProperty(reason, 'message', {
        get() { throw new Error('message getter failed') },
      })
      if (kind === 'name-accessor') Object.defineProperty(reason, 'name', {
        get() { throw new Error('name getter failed') },
      })
      const current = boundary === 'hook'
        ? runtime.agent({ id: `unrenderable-${kind}`, instructions: 'Reply', compaction: false })
          .createSession({ hooks: { beforeStep() { throw reason } } })
        : session
      adapter.resolveModel = async () => { throw reason }
      const input = boundary === 'hook' ? 'go' : createUserMessage({ source: { kind: 'user' }, content: [
        { type: 'image', source: { kind: 'url', url: 'https://example.test/image.png' } },
      ] })
      await expect(current.run(input, { imagePolicy: 'strict' })).rejects.toMatchObject({
        code: 'BROWSER_SESSION_CLOSED', report: { status: 'error' },
      })
      expect(current.isRunning).toBe(false)
    } finally { await runtime.close() }
  }, 2_000)

  it('preserves ordinary failure messages', () => {
    expect(messageOf(new Error('file not found'))).toBe('file not found')
    expect(messageOf(new Error(''))).toBe('')
    expect(messageOf('connection closed')).toBe('connection closed')
    expect(messageOf(42)).toBe('42')
    expect(messageOf(null)).toBe('null')
  })
})
