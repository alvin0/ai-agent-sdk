import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { ModelRegistry } from '../../../packages/core/src/runtime/registry.ts'
import { withRetry } from '../../../packages/core/src/runtime/with-retry.ts'
import { ModelError } from '../../../packages/core/src/errors/model-error.ts'
import { RunLedger } from '../../../packages/core/src/agent/accounting/ledger.ts'
import type { LegacyRunReport } from '../../../packages/core/src/agent/accounting/report.ts'
import { createCoreSpan, createOperationId, type ModelInvocationContext, type ObservationEvent } from '../../../packages/core/src/observation/index.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { createRuntimeResource } from '../../../packages/core/src/composition/delivery/resource.ts'
import { createRunTerminalRecord } from '../../../packages/core/src/composition/delivery/terminal.ts'
import { createDeliveryBatch } from '../../../packages/core/src/composition/delivery/batch.ts'
import type { ObservationDeliveryBatch } from '../../../packages/core/src/composition/exporter/delivery-types.ts'

export async function ledgerReport(
  runId = 'run-one', mode: 'complete' | 'missing' | 'estimated' | 'retry' | 'retry-exhausted'
    | 'failed' | 'overflow' | 'aggregate-overflow' = 'complete',
): Promise<LegacyRunReport> {
  class Adapter extends ModelAdapter {
    calls = 0
    async * stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
      this.calls++
      context?.declareProviderAttemptAccounting?.()
      const attempt = await context?.startProviderAttempt?.({ provider: options.provider, model: options.model, method: 'POST', origin: 'https://fixture.invalid' })
      if (mode === 'aggregate-overflow') {
        attempt?.end({ status: 'success', dispatchState: 'sent', reported: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER } })
        const second = await context?.startProviderAttempt?.({ provider: options.provider, model: options.model, method: 'POST', origin: 'https://fixture.invalid' })
        second?.end({ status: 'success', dispatchState: 'sent', reported: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } })
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (mode === 'failed' || mode === 'retry-exhausted' || (mode === 'retry' && this.calls === 1)) {
        attempt?.end({ status: 'error', dispatchState: 'sent', httpStatus: 503,
          providerRequestId: `fixture-request-${this.calls}`,
          error: { type: 'Error', code: 'TRANSIENT', message: 'PRIVATE_PROVIDER/BODY~SENTINEL%' } })
        throw new ModelError('PRIVATE_PROVIDER/BODY~SENTINEL%', 'TRANSIENT')
      }
      const usage = mode === 'overflow' ? { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER }
        : { inputTokens: 2, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 7, reasoningTokens: 2, totalTokens: 17 }
      attempt?.end({ status: 'success', dispatchState: 'sent',
        ...(mode === 'missing' ? {} : { reported: mode === 'estimated' ? { outputTokens: 3 } : usage }) })
      if (mode !== 'missing' && mode !== 'estimated') yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const registry = new ModelRegistry(), adapter = new Adapter()
  registry.registerAdapter(['account-a'], mode === 'retry' || mode === 'retry-exhausted' ? withRetry(adapter, {
    policy: { mode: 'normal', maxRetries: 1, retryableCodes: ['TRANSIENT'], backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
  }) : adapter)
  const ledger = new RunLedger({ runId, agentId: 'agent', mode: 'basic', maxTurns: 4,
    ...(mode === 'estimated' ? { usagePolicy: { onMissing: 'estimate' as const,
      estimator: { id: 'local-only', estimate: () => ({ inputTokens: 11, totalTokens: 14 }) } } } : {}),
  })
  const request = { provider: 'account-a', model: 'specialist', messages: [], system: 'PRIVATE_PROMPT/BODY~SENTINEL%' }
  const call = registry.stream(request, ledger.modelInvocation)
  try { for await (const _chunk of call) { /* real canonical call/attempt bookkeeping */ } } catch { /* retain the call report */ }
  await ledger.recordModelCall(await call.report, request)
  const failed = mode === 'failed' || mode === 'retry-exhausted'
  return ledger.finalize(failed ? 'error' : 'success', !failed)
}

export function event(runId = 'run-one', sequence = 1): ObservationEvent {
  const startedAt = new Date().toISOString()
  return { schemaVersion: 1, eventId: createOperationId(), name: 'sdk.agent.run', phase: 'point',
    sequence, occurredAt: startedAt, monotonicMs: 0, priority: 'critical',
    resource: { sdkName: 'ai-agent-sdk', sdkVersion: '0.1.0', runtime: 'unknown' },
    correlation: createCoreSpan({ name: 'sdk.agent.run', runId, startedAt, monotonicMs: 0 }).correlation,
    data: { status: 'success' },
  }
}

export async function deliveryBatch(): Promise<ObservationDeliveryBatch> {
  const platform = createRuntimePlatform()
  return createDeliveryBatch(createRuntimeResource(undefined, platform), [event()],
    [createRunTerminalRecord(await ledgerReport())], platform)
}
