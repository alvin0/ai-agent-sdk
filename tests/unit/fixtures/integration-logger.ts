import type { JsonObject } from '@ai-agent-sdk/core'
import type { SdkLogger } from '@ai-agent-sdk/core/observability'

export interface RecordedLogEntry {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  readonly message: string
  readonly fields: Readonly<JsonObject>
}

export class RecordingLogger implements SdkLogger {
  constructor(
    readonly entries: RecordedLogEntry[] = [],
    private readonly bound: Readonly<JsonObject> = {},
  ) {}

  child(fields: Readonly<JsonObject>): SdkLogger {
    return new RecordingLogger(this.entries, { ...this.bound, ...fields })
  }
  trace(message: string, fields?: Readonly<JsonObject>): void { this.add('trace', message, fields) }
  debug(message: string, fields?: Readonly<JsonObject>): void { this.add('debug', message, fields) }
  info(message: string, fields?: Readonly<JsonObject>): void { this.add('info', message, fields) }
  warn(message: string, fields?: Readonly<JsonObject>): void { this.add('warn', message, fields) }
  error(message: string, fields?: Readonly<JsonObject>): void { this.add('error', message, fields) }
  fatal(message: string, fields?: Readonly<JsonObject>): void { this.add('fatal', message, fields) }

  private add(level: RecordedLogEntry['level'], message: string, fields: Readonly<JsonObject> = {}): void {
    this.entries.push(Object.freeze({ level, message, fields: Object.freeze({ ...this.bound, ...fields }) }))
  }
}

export function integrationOperations(logger: RecordingLogger): string[] {
  return logger.entries
    .filter(entry => entry.fields.kind === 'logical-start')
    .map(entry => String(entry.fields.integrationOperation))
}
