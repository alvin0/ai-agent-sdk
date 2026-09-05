import type { CallConfig } from '../../../contract/index.ts'
import type { CorrelationContext } from '../../../observation/index.ts'
import type { SdkLogger } from '../../../logging/types.ts'
import type { RuntimeMemoryPersistence } from '../../memory/persistence-types.ts'
import type {
  ToolSourceRunReference, ToolSourceRunSnapshot,
} from '../../tool/source-types.ts'
import type { AgentSession } from '../session.ts'
import type { AgentInput, AgentInvocationOptions, AgentRunHandle } from './types.ts'
import type { CompactionResult } from '../../memory/compaction.ts'
import type { LegacyRunReport } from '../../accounting/report.ts'

export interface RuntimeSessionConfiguration
  extends Readonly<Pick<CallConfig, 'provider' | 'model' | 'reasoningEffort' | 'maxTokens'>> {
  readonly logger?: (correlation: CorrelationContext) => SdkLogger
  readonly prepareTools?: (
    signal: AbortSignal,
    logger: SdkLogger,
    occupiedNames: readonly string[],
  ) => ToolSourceRunSnapshot
  readonly memory?: RuntimeMemoryPersistence
}

export type RuntimeSessionRunHandle = AgentRunHandle & {
  readonly traceId: string
  readonly toolSourceSnapshots: Promise<readonly ToolSourceRunReference[]>
  readonly eventsSettled: Promise<void>
  abort(reason?: unknown): void
  seal(): AgentRunHandle['report']
}

type RuntimeStream = (
  input: AgentInput,
  invocation: AgentInvocationOptions,
  additionalInstructions?: string,
) => AgentRunHandle

export interface RuntimeCompactionOutcome {
  readonly result: CompactionResult | null
  readonly report: LegacyRunReport
  readonly failure?: unknown
}

type RuntimeCompact = (invocation: AgentInvocationOptions) => Promise<RuntimeCompactionOutcome>

const streams = new WeakMap<AgentSession, RuntimeStream>()
const compactors = new WeakMap<AgentSession, RuntimeCompact>()
const configurations = new WeakMap<AgentSession, RuntimeSessionConfiguration>()
const configured = new WeakMap<AgentSession, () => void>()

export function attachRuntimeSession(
  session: AgentSession,
  stream: RuntimeStream,
  compact: RuntimeCompact,
  onConfigure: () => void,
): void {
  streams.set(session, stream)
  compactors.set(session, compact)
  configured.set(session, onConfigure)
}

export function compactRuntimeSession(
  session: AgentSession,
  invocation: AgentInvocationOptions,
): Promise<RuntimeCompactionOutcome> {
  const compact = compactors.get(session)
  if (compact === undefined) throw new TypeError('Runtime session is unavailable')
  return compact(invocation)
}

export function runtimeSessionConfiguration(
  session: AgentSession,
): RuntimeSessionConfiguration | undefined {
  return configurations.get(session)
}

/** Internal composition seam; keeps run-only overlays out of preserved legacy options. */
export function streamRuntimeSession(
  session: AgentSession,
  input: AgentInput,
  invocation: AgentInvocationOptions,
  additionalInstructions?: string,
): RuntimeSessionRunHandle {
  const stream = streams.get(session)
  if (stream === undefined) throw new TypeError('Runtime session is unavailable')
  return stream(input, invocation, additionalInstructions) as RuntimeSessionRunHandle
}

/** Preserve reasoning-effort omission while binding one high-level runtime session. */
export function configureRuntimeSessionModel(
  session: AgentSession,
  configuration: RuntimeSessionConfiguration,
): void {
  const onConfigure = configured.get(session)
  if (onConfigure === undefined) throw new TypeError('Runtime session is unavailable')
  configurations.set(session, Object.freeze({ ...configuration }))
  onConfigure()
}
