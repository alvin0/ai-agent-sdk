import type { GenerateOptions } from '../contract/generate-options.ts'
import type { StreamChunk } from '../stream/chunk.ts'
import type { ObservationResource } from '../observation/event.ts'
import type { ObservationPort } from '../observation/port.ts'
import type { ModelCallHandle, ModelInvocationContext } from '../observation/report.ts'
import { captureModelCall } from './model-call-config.ts'
import { ModelCallRuntime } from './model-call-runtime.ts'

export interface CreateModelCallHandleOptions {
  readonly options: GenerateOptions
  readonly providerFamily?: string
  readonly providerPluginId?: string
  readonly isRetryable?: (code: string) => boolean
  readonly context?: ModelInvocationContext
  readonly defaultObservation?: ObservationPort
  readonly resource: ObservationResource
  readonly routePresent: boolean
  readonly dispatchState: () => 'not-sent' | 'unknown'
  readonly stream: (context: ModelInvocationContext) => AsyncIterable<StreamChunk>
}

export function createModelCallHandle(input: CreateModelCallHandleOptions): ModelCallHandle {
  return new ModelCallRuntime(captureModelCall(input)).handle()
}
