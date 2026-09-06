/**
 * Copy to tests/unit/composition/premerge-review.regression.spec.ts.
 * Target source SHA: 80353b38da2411450a5c4e0c1e6ce7e4c5cdebf7.
 * Suggested execution AFTER repairing CI/toolchain:
 *   pnpm exec vitest run tests/unit/composition/premerge-review.regression.spec.ts
 *
 * NOT EXECUTED against the repository in this review environment.
 * These tests specify the proposed merge-safety contract; several should fail
 * on the reviewed snapshot. All providers/tools are local mocks, with no API cost.
 * The ownership test is deliberately white-box and may need adjustment if the
 * owner representation changes from an array to a Set or compact tombstones.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import { ToolCallId } from '../../../packages/core/src/primitives/brand.ts'
import { defineTool } from '../../../packages/core/src/agent/tool/definition.ts'
import { ToolRegistry } from '../../../packages/core/src/agent/tool/registry.ts'
import type { History } from '../../../packages/core/src/agent/history/history.ts'
import { runToolCalls } from '../../../packages/core/src/agent/loop/schedule.ts'
import { createTraceId, createSpanId } from '../../../packages/core/src/agent/trace/trace.ts'
import { fileSystemSkills } from '../../../packages/skill-filesystem/src/provider/filesystem-provider.ts'

const SENTINEL = 'REVIEW_SENTINEL_NOT_A_REAL_SECRET'
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

class ReviewAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(readonly invokeTool = true) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.invokeTool && this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId('review-call'), name: 'work', arguments: '{}',
      } }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function provider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'review-provider',
    displayName: 'Review Provider', routes: ['review'],
    defaultModel: { provider: 'review', id: 'model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['review'], adapter) },
  }
}

describe('proposed pre-merge safety regressions', () => {
  it('R04: a blocked result must not inject additionalContext into the next model request', async () => {
    const adapter = new ReviewAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    try {
      const session = runtime.agent({
        id: 'block-review', instructions: 'Use work, then answer.', compaction: false,
        tools: [defineTool({
          name: 'work', description: 'Return test content.', parameters: { type: 'object' },
          execute: (_args, context) => {
            context.addContext(SENTINEL)
            return { ok: true }
          },
        })],
      }).createSession({ interceptors: [{
        name: 'blocking-policy',
        after: async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'Blocked by policy' }] }),
      }] })
      await session.run('go')
      expect(adapter.requests.length).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(adapter.requests.slice(1).map(request => request.messages)))
        .not.toContain(SENTINEL)
    } finally { await runtime.close() }
  })

  it('R04: replacing sensitive output must sanitize the public event, not only content', async () => {
    const adapter = new ReviewAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const events: unknown[] = []
    try {
      const session = runtime.agent({
        id: 'replace-review', instructions: 'Use work, then answer.', compaction: false,
        tools: [defineTool({ name: 'work', description: 'Return a test value.',
          parameters: { type: 'object' }, execute: () => ({ privateData: SENTINEL }) })],
      }).createSession({ interceptors: [{
        name: 'redacting-policy',
        after: async () => ({ kind: 'replace', content: [{ type: 'text', text: '[REDACTED]' }] }),
      }] })
      await session.run('go', { onEvent: event => { events.push(event) } })
      expect(JSON.stringify(events)).not.toContain(SENTINEL)
    } finally { await runtime.close() }
  })

  it('R02: closed-team report metadata must not retain heavyweight member sessions', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new ReviewAdapter(false))] })
    try {
      const agent = runtime.agent({ id: 'member-review', instructions: 'Answer.', compaction: false })
      const team = runtime.team({ id: 'closed-review', members: [{ name: 'lead', agent }] })
      team.session('lead').inject('history retained for this lifecycle test')
      await team.close()
      // Keep report compatibility, but inspect the owning root rather than a
      // local reference to a removed registration.
      const registrations = Reflect.get(runtime, 'teams') as readonly object[]
      const retainedMemberCount = registrations.reduce((count, registration) => {
        const sessions: unknown = Reflect.get(registration, 'sessions')
        return count + (sessions instanceof Map ? sessions.size : 0)
      }, 0)
      expect(retainedMemberCount).toBe(0)
      const report = await runtime.close()
      expect(report.components).toContainEqual({ kind: 'agent-team', id: 'closed-review', status: 'closed' })
    } finally { await runtime.close() }
  })

  it('R03: admission failure in a later sibling must drain already dispatched bodies', async () => {
    const registry = new ToolRegistry()
    let release!: () => void
    const bodyGate = new Promise<void>(resolve => { release = resolve })
    let bodyStarted = false, bodyFinished = false
    registry.register(defineTool({
      name: 'slow', description: 'A controllable test body.', parameters: { type: 'object' },
      isConcurrencySafe: () => true,
      execute: async () => { bodyStarted = true; await bodyGate; bodyFinished = true; return { ok: true } },
    }))
    registry.register(defineTool({
      name: 'later', description: 'Must fail before dispatch.', parameters: { type: 'object' },
      isConcurrencySafe: () => true, execute: () => ({ ok: true }),
    }))
    // This test isolates scheduling ownership, not history validation.
    const history = { append() {}, snapshot: () => ({ version: 1, entries: [] }) } as unknown as History
    let settled = false
    const pending = runToolCalls({
      calls: [
        { callId: ToolCallId('slow-call'), toolName: 'slow', rawArguments: '{}' },
        { callId: ToolCallId('later-call'), toolName: 'later', rawArguments: '{}' },
      ],
      catalog: registry, history, position: { turn: 1, step: 1 },
      signal: new AbortController().signal,
      parentTrace: { traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null },
      maxParallel: 2, maxDurationMs: 2_000, teardownTimeoutMs: 500,
      interceptors: [{ name: 'admission', before: async call => {
        if (call.toolName === 'later') throw new Error('REVIEW_ADMISSION_FAILURE')
        return { kind: 'allow' }
      } }],
    })
    const observed = pending.then(() => { settled = true }, () => { settled = true })
    try {
      await pause(20)
      expect(bodyStarted).toBe(true)
      expect(bodyFinished).toBe(false)
      // No timeout has elapsed: completion must still own/drain the first body.
      expect(settled).toBe(false)
    } finally {
      release()
      await observed
      await pause(0)
    }
  })

  it('R07: inline YAML comments must not weaken allow_implicit_invocation: false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-premerge-review-'))
    try {
      const skill = join(root, 'review-skill')
      await mkdir(join(skill, 'agents'), { recursive: true })
      await writeFile(join(skill, 'SKILL.md'),
        '---\nname: review-skill\ndescription: A local policy regression fixture.\n---\nOnly invoke explicitly.\n')
      await writeFile(join(skill, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: false # explicit invocation only\n')
      const skills = fileSystemSkills({ roots: [root] })
      const candidates = await skills.list({})
      expect(candidates).toHaveLength(1)
      expect(candidates[0]?.invocation.modelInvocable).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
