import type { ModelInvocationContext, ResolvedRetryPolicy } from '@alvin0/ai-agent-sdk-core/provider'
import type { DecisionModelInfo, DecisionRequest, DecisionResult } from './types.ts'

export interface PreparedDecisionCall {
  readonly model: DecisionModelInfo
  evaluate(request: DecisionRequest, context?: ModelInvocationContext): Promise<DecisionResult>
}
/** One evaluate is one physical attempt. Retry belongs to the decision runtime. */
export abstract class DecisionAdapter {
  listModels(_provider: string, _signal?: AbortSignal): Promise<readonly DecisionModelInfo[]> { return Promise.resolve([]) }
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<DecisionModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined { return undefined }
  async prepareDecisionCall(provider: string, model: string, signal?: AbortSignal, context?: ModelInvocationContext): Promise<PreparedDecisionCall> {
    const info = await this.resolveModel(provider, model, signal)
    return Object.freeze({ model: info, evaluate: (request: DecisionRequest, invocation = context) => this.evaluate(request, invocation) })
  }
  abstract evaluate(request: DecisionRequest, context?: ModelInvocationContext): Promise<DecisionResult>
}
