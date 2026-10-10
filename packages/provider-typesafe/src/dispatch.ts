import { dispatchDecisionHttp, type DecisionHttpHost, type DecisionHttpRequest }
  from '@alvin0/ai-agent-sdk-decision-adapter/transport'
import { responseUsage } from './response.ts'

export type TypesafeDispatchHost = Omit<DecisionHttpHost, 'label' | 'readUsage'>
export type TypesafeDispatchRequest = DecisionHttpRequest

export function dispatchTypesafe(host: TypesafeDispatchHost, request: TypesafeDispatchRequest) {
  return dispatchDecisionHttp({ ...host, label: 'TypeSafe', readUsage: responseUsage }, request)
}
