import { expect, it } from 'vitest'
import { createObservationRunScope } from '../../packages/core/src/observation/context.ts'
import { scopeFor } from '../../packages/core/src/runtime/model-call-support.ts'
import { ModelAdapter } from '../../packages/core/src/contract/adapter.ts'
import { ModelRegistry } from '../../packages/core/src/runtime/registry.ts'
import type { GenerateOptions } from '../../packages/core/src/contract/generate-options.ts'
import type { ModelInvocationContext } from '../../packages/core/src/observation/report.ts'
import type { ObservationRunScope } from '../../packages/core/src/observation/context.ts'
import type { StreamChunk } from '../../packages/core/src/stream/chunk.ts'

it('keeps automatically identified calls independent when the context is reused', () => {
  const context = {}
  const first = scopeFor(context, undefined)
  const second = scopeFor(context, undefined)

  expect(second).not.toBe(first)
  expect(first.nextSequence()).toBe(1)
  expect(second.nextSequence()).toBe(1)
})

it('preserves explicit same-run scope sharing and supplied scopes', () => {
  const context = {}
  const first = scopeFor(context, 'run')
  expect(scopeFor(context, 'run')).toBe(first)
  expect(scopeFor(context, 'other-run')).not.toBe(first)

  const supplied = createObservationRunScope()
  expect(scopeFor(context, undefined, supplied)).toBe(supplied)
  expect(scopeFor(context, 'run', supplied)).toBe(supplied)
})

it('does not cache generated run scopes on a reusable registry invocation context', async () => {
  let dispatchedScope: ObservationRunScope | undefined
  class Fixture extends ModelAdapter {
    override async *stream(_options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
      dispatchedScope = context?.scope
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const registry = new ModelRegistry()
  registry.registerAdapter(['fixture'], new Fixture())
  const context = {}
  const handle = registry.stream({ provider: 'fixture', model: 'fixture', messages: [] }, context)
  for await (const chunk of handle) expect(chunk.type).toBe('finish')
  await handle.report

  expect(dispatchedScope).toBeDefined()
  expect(scopeFor(context, handle.runId)).not.toBe(dispatchedScope)
})
