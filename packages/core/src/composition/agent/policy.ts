import type { UsageEstimationInput, UsageEstimator, UsagePolicy } from '../../agent/accounting/report.ts'
import type { TurnHooks } from '../../agent/loop/events.ts'
import type { UserInputBroker, UserInputDecision, UserInputRequest } from '../../agent/mode/user-input.ts'
import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from '../../agent/tool/approval.ts'
import type { ToolExecutionResult } from '../../agent/tool/definition.ts'
import type { PostToolDecision, PreToolDecision, ToolCallContext, ToolInterceptor } from '../../agent/tool/pipeline.ts'
import type { UsageCounters } from '../../observation/usage.ts'
import { arrayData, boundedText, objectValue, ownData } from '../common/data.ts'

const POLICY_LIMITS = Object.freeze({ interceptors: 128, identityBytes: 256 })

export function captureApprovalBroker(value: unknown): ApprovalBroker | undefined {
  if (value === undefined) return undefined
  const source = objectValue(value)
  const request = captureMethod<[ApprovalRequest, AbortSignal?], Promise<ApprovalDecision>>(source, 'request', true)!
  return Object.freeze({ request })
}

export function captureUserInputBroker(value: unknown): UserInputBroker | undefined {
  if (value === undefined) return undefined
  const source = objectValue(value)
  const request = captureMethod<[UserInputRequest, AbortSignal?], Promise<UserInputDecision>>(source, 'request', true)!
  return Object.freeze({ request })
}

export function captureInterceptors(value: unknown): readonly ToolInterceptor[] | undefined {
  if (value === undefined) return undefined
  return Object.freeze(arrayData(value, POLICY_LIMITS.interceptors).map((entry) => {
    const source = objectValue(entry)
    const name = boundedText(ownData(source, 'name'), POLICY_LIMITS.identityBytes)
    const before = captureMethod<[ToolCallContext, () => Promise<PreToolDecision>], Promise<PreToolDecision>>(source, 'before', false)
    const around = captureMethod<[ToolCallContext, () => Promise<ToolExecutionResult>], Promise<ToolExecutionResult>>(source, 'around', false)
    const after = captureMethod<[
      ToolCallContext, ToolExecutionResult, () => Promise<PostToolDecision>,
    ], Promise<PostToolDecision>>(source, 'after', false)
    return Object.freeze({ name, ...(before === undefined ? {} : { before }),
      ...(around === undefined ? {} : { around }), ...(after === undefined ? {} : { after }) })
  }))
}

export function captureTurnHooks(value: unknown): TurnHooks | undefined {
  if (value === undefined) return undefined
  const source = objectValue(value)
  const beforeStep = captureMethod<Parameters<NonNullable<TurnHooks['beforeStep']>>, ReturnType<NonNullable<TurnHooks['beforeStep']>>>(source, 'beforeStep', false)
  const onRequestError = captureMethod<Parameters<NonNullable<TurnHooks['onRequestError']>>, ReturnType<NonNullable<TurnHooks['onRequestError']>>>(source, 'onRequestError', false)
  const checkpoint = captureMethod<Parameters<NonNullable<TurnHooks['checkpoint']>>, ReturnType<NonNullable<TurnHooks['checkpoint']>>>(source, 'checkpoint', false)
  const onTurnEnd = captureMethod<Parameters<NonNullable<TurnHooks['onTurnEnd']>>, ReturnType<NonNullable<TurnHooks['onTurnEnd']>>>(source, 'onTurnEnd', false)
  return Object.freeze({ ...(beforeStep === undefined ? {} : { beforeStep }),
    ...(onRequestError === undefined ? {} : { onRequestError }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(onTurnEnd === undefined ? {} : { onTurnEnd }) })
}

export function captureUsagePolicy(value: unknown): UsagePolicy | undefined {
  if (value === undefined) return undefined
  const source = objectValue(value)
  const onMissing = ownData(source, 'onMissing', false)
  if (onMissing !== undefined && onMissing !== 'warn' && onMissing !== 'estimate' && onMissing !== 'fail') {
    throw new TypeError('Runtime usage policy is invalid')
  }
  const estimatorValue = ownData(source, 'estimator', false)
  let estimator: UsageEstimator | undefined
  if (estimatorValue !== undefined) {
    const estimatorSource = objectValue(estimatorValue)
    const id = boundedText(ownData(estimatorSource, 'id'), POLICY_LIMITS.identityBytes)
    const estimate = captureMethod<[UsageEstimationInput], UsageCounters | Promise<UsageCounters>>(
      estimatorSource, 'estimate', true,
    )!
    estimator = Object.freeze({ id, estimate })
  }
  return Object.freeze({ ...(onMissing === undefined ? {} : { onMissing }),
    ...(estimator === undefined ? {} : { estimator }) }) as UsagePolicy
}

function captureMethod<Args extends readonly unknown[], Result>(
  receiver: object,
  key: string,
  required: boolean,
): ((...args: Args) => Result) | undefined {
  let method: unknown
  try { method = Reflect.get(receiver, key) }
  catch { throw new TypeError(`Runtime policy method '${key}' could not be captured`) }
  if (method === undefined && !required) return undefined
  if (typeof method !== 'function') throw new TypeError(`Runtime policy method '${key}' is invalid`)
  return (...args: Args): Result => Reflect.apply(method, receiver, args) as Result
}
