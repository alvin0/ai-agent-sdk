import type { JsonObject } from '../primitives/json.ts'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/** Minimal structured logger contract shared without reversing observation ownership. */
export interface SdkLogger {
  child(fields: Readonly<JsonObject>): SdkLogger
  trace(message: string, fields?: Readonly<JsonObject>): void
  debug(message: string, fields?: Readonly<JsonObject>): void
  info(message: string, fields?: Readonly<JsonObject>): void
  warn(message: string, fields?: Readonly<JsonObject>): void
  error(message: string, fields?: Readonly<JsonObject>): void
  fatal(message: string, fields?: Readonly<JsonObject>): void
}

type LoggedOperationStatus = 'success' | 'error' | 'aborted' | 'rejected' | 'unknown'

/** Metadata-only operation envelope shared by runtime-active integrations. */
export type IntegrationOperationEvidenceFields =
  | (JsonObject & {
      readonly integrationSchemaVersion: 1
      readonly integrationFamily: string
      readonly integrationOperation: string
      readonly operationId: string
      readonly kind: 'logical-start'
    })
  | (JsonObject & {
      readonly integrationSchemaVersion: 1
      readonly integrationFamily: string
      readonly integrationOperation: string
      readonly operationId: string
      readonly kind: 'attempt-start'
      readonly attemptId: string
      readonly attemptNumber: number
    })
  | (JsonObject & {
      readonly integrationSchemaVersion: 1
      readonly integrationFamily: string
      readonly integrationOperation: string
      readonly operationId: string
      readonly kind: 'attempt-terminal'
      readonly attemptId: string
      readonly attemptNumber: number
      readonly status: LoggedOperationStatus
      readonly durationMs: number
      readonly errorCode?: string
    })
  | (JsonObject & {
      readonly integrationSchemaVersion: 1
      readonly integrationFamily: string
      readonly integrationOperation: string
      readonly operationId: string
      readonly kind: 'logical-terminal'
      readonly status: LoggedOperationStatus
      readonly durationMs: number
      readonly errorCode?: string
    })

export const CLOSED_RUNTIME_LOGGER: SdkLogger = Object.freeze({
  child: () => CLOSED_RUNTIME_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})
