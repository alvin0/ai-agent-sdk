import { backoffDelayMs, isRetryable, ModelError, MODEL_ERROR_CODES, normalizeModelFailure,
  resolveRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import type { ModelInvocationContext, ResolvedRetryPolicy, RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core/provider'
import type { DecisionAdapter } from './adapter.ts'
import { abortable, throwIfAborted, waitDecisionDelay } from './async.ts'
import { DECISION_PROVIDER_PLUGIN_API_VERSION, type DecisionProviderPlugin,
  type DecisionProviderRegistrar } from './plugin.ts'
import type { DecisionInput, DecisionModelHandle, DecisionModelTarget, DecisionQuestions } from './types.ts'
import { bindDecisionInput, identifier, snapshotDecisionInput, snapshotDecisionModelInfo,
  validateDecisionResult } from './validation.ts'

export interface DecisionRuntimeOptions {
  readonly providers?: readonly DecisionProviderPlugin[]
  readonly retryPolicy?: RetryPolicyConfig
  readonly timeoutMs?: number
  readonly context?: ModelInvocationContext
}
export interface DecisionRuntime extends DecisionProviderRegistrar {
  decisionModel(target: DecisionModelTarget): DecisionModelHandle
  close(): Promise<void>
}
/** Companion runtime: never registers decision models as chat/embedding models. */
export function createDecisionRuntime(options: DecisionRuntimeOptions = {}): DecisionRuntime {
  const state = new DecisionRuntimeState(options)
  const runtime: DecisionRuntime = {
    registerAdapter: state.registerAdapter.bind(state),
    decisionModel: state.decisionModel.bind(state),
    close: state.close.bind(state),
  }
  state.install(options.providers, runtime)
  return Object.freeze(runtime)
}
class DecisionRuntimeState {
  private readonly routes = new Map<string, { readonly adapter: DecisionAdapter;
    readonly retryPolicy: ResolvedRetryPolicy }>()
  private readonly cleanups: (() => void)[] = []
  private readonly root = new AbortController()
  private readonly defaultPolicy: ResolvedRetryPolicy
  private readonly defaultTimeout: number
  private readonly defaultContext: ModelInvocationContext | undefined
  private closed = false
  constructor(options: DecisionRuntimeOptions) {
    this.defaultPolicy = resolveRetryPolicy(options.retryPolicy, 'decision.retryPolicy')
    this.defaultTimeout = options.timeoutMs ?? 30_000
    this.defaultContext = options.context
    validateRuntimeTimeout(this.defaultTimeout)
  }
  registerAdapter(selected: readonly string[], adapter: DecisionAdapter) {
    if (this.closed) throw new ModelError('Decision runtime is closed', 'DECISION_RUNTIME_CLOSED')
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length ||
        typeof adapter?.evaluate !== 'function' ||
          typeof adapter?.prepareDecisionCall !== 'function') throw new Error('Invalid decision registration')
    selected.forEach(route => { identifier(route, 'Provider route'); if (this.routes.has(
      route)) throw new ModelError('Decision route already registered', 'DECISION_ROUTE_CONFLICT') })
    const captured = [...selected]
    const entries = captured.map(route => {
      const policy = adapter.providerRetryPolicy(route) ?? this.defaultPolicy
      // Capture route policy before committing any registration.
      const retryPolicy = resolveRetryPolicy({ mode: policy.mode, ...(policy.mode === 'normal' ? {
        maxRetries: policy.maxRetries, retryableCodes: policy.retryableCodes } : {}), backoff: {
        initialDelayMs: policy.initialDelayMs, maxDelayMs: policy.maxDelayMs,
        jitterRatio: policy.jitterRatio } }, 'decision.route.retryPolicy')
      return { route, entry: Object.freeze({ adapter, retryPolicy }) }
    })
    entries.forEach(({ route, entry }) => this.routes.set(route, entry))
    let disposed = false
    return Object.freeze({ dispose: () => { if (!disposed) { disposed = true; entries.forEach(({ route,
      entry }) => { if (this.routes.get(route) === entry) this.routes.delete(route) }) } } })

  }
  decisionModel(target: DecisionModelTarget): DecisionModelHandle {
    const provider = identifier(target.provider, 'Provider route')
    const model = identifier(target.model, 'Model id')
    const state = this
    return Object.freeze({
      async evaluate<Q extends DecisionQuestions>(input: DecisionInput<Q>, context = state.defaultContext) {
        return state.evaluate({ provider, model }, input, context)
      },
    })
  }
  private async evaluate<Q extends DecisionQuestions>(
    target: DecisionModelTarget, input: DecisionInput<Q>, context: ModelInvocationContext | undefined,
  ) {
    const { provider, model } = target

    if (this.closed) throw new ModelError('Decision runtime is closed', 'DECISION_RUNTIME_CLOSED')
    const registration = this.routes.get(provider)
    if (!registration) throw new ModelError('No decision adapter registered for this route',
      'DECISION_ADAPTER_MISSING')
    const { adapter, retryPolicy: policy } = registration
    const timeout = input.timeoutMs ?? this.defaultTimeout
    validateRuntimeTimeout(timeout)
    const controller = new AbortController()
    const signal = AbortSignal.any([this.root.signal, controller.signal, ...(
      input.signal === undefined ? [] : [input.signal])])
    const timer = setTimeout(() => controller.abort(new ModelError('Decision deadline exceeded',
      MODEL_ERROR_CODES.TIMEOUT)), timeout)
    try {
      throwIfAborted(signal)
      // Capture the caller's JSON before the first await, including preparation.
      const initial = bindDecisionInput(input, { signal, timeoutMs: timeout })
      const prepared = await abortable(adapter.prepareDecisionCall(provider, model, signal, context), signal)
      const info = snapshotDecisionModelInfo(prepared.model)
      if (info.provider !== provider || info.id !== model) throw new ModelError(
        'Prepared decision model identity mismatch', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
      const request = bindDecisionInput(snapshotDecisionInput(initial, info.capabilities), { provider, model })
      return await evaluatePreparedDecision(prepared, request, { policy, context, signal })
    } finally {
      clearTimeout(timer)
    }

  }
  async close() {
    if (this.closed) return
    this.closed = true
    this.root.abort()
    this.routes.clear()
    const failures: unknown[] = []
    for (const cleanup of this.cleanups.reverse()) { try { cleanup() } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, 'Decision provider cleanup failed')

  }
  install(providers: readonly DecisionProviderPlugin[] | undefined, runtime: DecisionRuntime): void {
    try {
      const ids = new Set<string>()
      for (const plugin of providers ?? []) {
        validatePlugin(plugin, ids)
        const claims = new Set(plugin.routes)
        const cleanup = plugin.setup(Object.freeze({ registerAdapter(selected: readonly string[],
          adapter: DecisionAdapter) {
          if (selected.some(route => !claims.has(route))) throw new Error(
            'Decision plugin registration escapes route claims')
          return runtime.registerAdapter(selected, adapter)
        } }))
        if (cleanup !== undefined && typeof cleanup !== 'function') throw new Error('Invalid decision plugin cleanup')
        if (cleanup) this.cleanups.push(cleanup)
      }
    } catch (error) {
      this.closed = true
      this.root.abort()
      this.routes.clear()
      for (const cleanup of this.cleanups.reverse()) { try { cleanup() } catch { /* preserve setup failure */ } }
      throw error
    }
  }
}
function validateRuntimeTimeout(timeout: number): void {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error(
    'Invalid decision timeout')
}

async function evaluatePreparedDecision<Q extends DecisionQuestions>(
  prepared: import('./adapter.ts').PreparedDecisionCall, request: DecisionInput<Q> & DecisionModelTarget,
  invocation: { readonly policy: ResolvedRetryPolicy; readonly context: ModelInvocationContext | undefined;
    readonly signal: AbortSignal },
) {
  const { policy, context, signal } = invocation
  for (let retries = 0; ; retries++) {
    throwIfAborted(signal)
    try {
      const result = await abortable(prepared.evaluate(request, context), signal)
      throwIfAborted(signal)
      return validateDecisionResult(result, request.questions)
    } catch (error) {
      throwIfAborted(signal)
      const failure = normalizeModelFailure(error)
      if (!isRetryable(policy, failure.code, retries) ||
        failure.code === MODEL_ERROR_CODES.ABORTED) throw error
      const delay = Math.min(policy.maxDelayMs, failure.providerRetryAfterMs ?? backoffDelayMs(
        policy, retries + 1))
      context?.recordProviderRetry?.({ nextAttemptNumber: retries + 2, delayMs: delay,
        failureCode: failure.code })
      await waitDecisionDelay(delay, signal)
    }
  }
}

function validatePlugin(plugin: DecisionProviderPlugin, ids: Set<string>): void {
  if (plugin.kind !== 'decision-provider-plugin' ||
    plugin.apiVersion !== DECISION_PROVIDER_PLUGIN_API_VERSION || ids.has(plugin.id)) throw new Error(
    'Incompatible or duplicate decision plugin')
  identifier(plugin.id, 'Plugin id')
  ids.add(plugin.id)
}
