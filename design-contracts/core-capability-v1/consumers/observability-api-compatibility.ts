import * as Current from '@current/observability'
import * as Target from '@ai-agent-sdk/core/observability'

type Equivalent<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left] ? true : false
    : false
type Assert<Value extends true> = Value

type Select<Value, Keys extends PropertyKey> = {
  [Key in Keys]: Key extends keyof Value ? Value[Key] : never
}
type MemoryPublic<Value> = Select<Value,
  'id' | 'supportedBoundaries' | 'export' | 'events' | 'batches' | 'clear'>
type TestPublic<Value> = Select<Value,
  'id' | 'supportedBoundaries' | 'exported' | 'shutdownCalls' | 'export' | 'shutdown'>

export function memoryPublicCompatibility(
  value: Target.MemoryObservationExporter,
): MemoryPublic<Current.MemoryObservationExporter> {
  return value
}

export function testPublicCompatibility(
  value: Target.TestObservationExporter,
): TestPublic<Current.TestObservationExporter> {
  return value
}

/** Compile-only proof that the advanced observability subpath preserves v0 source types. */
export type ObservabilityApiCompatibility = [
  Assert<Equivalent<Current.ObservationContentPolicy, Target.ObservationContentPolicy>>,
  Assert<Equivalent<Current.LogLevel, Target.LogLevel>>,
  Assert<Equivalent<Current.ObservationBatch, Target.ObservationBatch>>,
  Assert<Equivalent<Current.ExportAck, Target.ExportAck>>,
  Assert<Equivalent<Current.ObservationExporter, Target.ObservationExporter>>,
  Assert<Equivalent<Current.ObservationExporterRegistration, Target.ObservationExporterRegistration>>,
  Assert<Equivalent<Current.FlushResult, Target.FlushResult>>,
  Assert<Equivalent<Current.ObservationHealthSnapshot, Target.ObservationHealthSnapshot>>,
  Assert<Equivalent<Current.ObservationProcessor, Target.ObservationProcessor>>,
  Assert<Equivalent<Current.ContentRedactor, Target.ContentRedactor>>,
  Assert<Equivalent<Current.SdkLogger, Target.SdkLogger>>,
  Assert<Equivalent<Current.LoggerContext, Target.LoggerContext>>,
  Assert<Equivalent<Current.ObservabilityOptions, Target.ObservabilityOptions>>,
  Assert<Equivalent<Current.Observability, Target.Observability>>,
  Assert<Equivalent<Current.TraceProjection, Target.TraceProjection>>,
  Assert<Equivalent<Current.LogProjection, Target.LogProjection>>,
  Assert<Equivalent<Current.MetricProjection, Target.MetricProjection>>,
  Assert<Equivalent<typeof Current.createObservability, typeof Target.createObservability>>,
  Assert<Equivalent<
    ConstructorParameters<typeof Current.MemoryObservationExporter>,
    ConstructorParameters<typeof Target.MemoryObservationExporter>
  >>,
  Assert<Equivalent<Current.TestObservationExporterOptions, Target.TestObservationExporterOptions>>,
  Assert<Equivalent<
    ConstructorParameters<typeof Current.TestObservationExporter>,
    ConstructorParameters<typeof Target.TestObservationExporter>
  >>,
  Assert<Equivalent<typeof Current.projectTrace, typeof Target.projectTrace>>,
  Assert<Equivalent<typeof Current.projectLog, typeof Target.projectLog>>,
  Assert<Equivalent<typeof Current.projectMetrics, typeof Target.projectMetrics>>,
]
