/**
 * Golden-oracle recorder for the generation (SSE) pipeline.
 *
 * This module exists to freeze the OBSERVABLE behaviour of
 * `packages/provider-http/src/base/http-adapter.ts` before that file is
 * refactored onto the shared transport layer. It replays every SSE fixture the
 * four official providers already ship in their unit suites and records, per
 * case: the normalized `StreamChunk` sequence, the set of error codes, the
 * `dispatchState` of every provider attempt, how many times `attempt.end` was
 * called, and the redacted header set observed on the wire request.
 *
 * Nothing here reads or writes provider source. The recorder drives each adapter
 * through its public surface with an injected `fetch`, so the record is a
 * behavioural oracle rather than a snapshot of implementation details.
 *
 * @module ai-agent-sdk/tests/fixtures/generation-oracle
 */

import type {
  AttemptUsageReport,
  EndProviderAttemptInput,
  ModelAdapter,
  ModelInvocationContext,
  ProviderAttemptHandle,
  StartProviderAttemptInput,
  StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import type { ProviderRequestLogger } from '@alvin0/ai-agent-sdk-provider-http'
import { anthropicAdapter } from '@alvin0/ai-agent-sdk-provider-anthropic'
import { codexAdapter, memoryCodexAuthStore } from '@alvin0/ai-agent-sdk-provider-codex'
import { geminiAdapter } from '@alvin0/ai-agent-sdk-provider-gemini'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'

/** Record shape version; bump only when the recorded fields themselves change. */
export const GENERATION_ORACLE_VERSION = 1

/** Providers whose generation path the refactor touches. */
export type OracleProvider = 'openai' | 'gemini' | 'anthropic' | 'codex'

/** One replayable transport situation. */
export type OracleScenario =
  | 'complete'
  | 'missing-usage'
  | 'malformed-usage'
  | 'stream-bound-failure'
  | 'truncated-stream'
  | 'media-type-invalid'
  | 'http-error'
  | 'transport-failure'

/** What a provider factory receives from the recorder. */
export interface OracleAdapterInput {
  readonly fetch: typeof globalThis.fetch
  readonly models: readonly { readonly id: string; readonly name: string }[]
  readonly maxSseEvents: number
  readonly requestLogger: ProviderRequestLogger
}

/** Everything needed to replay one provider/scenario pair. */
export interface OracleCase {
  readonly provider: OracleProvider
  readonly scenario: OracleScenario
  readonly model: string
  /** SSE frames handed to the adapter, absent for the non-SSE scenarios. */
  readonly frames?: readonly string[]
  readonly maxSseEvents: number
  createAdapter(input: OracleAdapterInput): ModelAdapter
}

/** One recorded provider attempt, reduced to the facts the transport owns. */
export interface OracleAttemptRecord {
  readonly attemptNumber: number
  readonly method: string
  readonly origin: string
  readonly status: EndProviderAttemptInput['status']
  readonly dispatchState: EndProviderAttemptInput['dispatchState']
  readonly httpStatus?: number
  readonly providerRequestId?: string
  readonly errorCode?: string
}

/** Stable facts of a failure that ended a case by throwing. */
export interface OracleThrownRecord {
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}

/** The frozen behaviour of one provider/scenario pair. */
export interface OracleRecord {
  readonly schemaVersion: typeof GENERATION_ORACLE_VERSION
  readonly provider: OracleProvider
  readonly scenario: OracleScenario
  readonly model: string
  /** Normalized `StreamChunk` sequence, in emission order. */
  readonly chunks: readonly unknown[]
  /** Every stable error code seen, from thrown errors and terminal finishes. */
  readonly errorCodes: readonly string[]
  /** Terminal thrown failure, when the case ends by throwing. */
  readonly thrown?: OracleThrownRecord
  readonly attempts: readonly OracleAttemptRecord[]
  /** How many times `attempt.end` ran; must equal one per opened attempt. */
  readonly attemptEndCalls: number
  /** Header names observed on the wire request, sorted. */
  readonly requestHeaderNames: readonly string[]
  /** Header names whose value the pipeline replaced with `[REDACTED]`, sorted. */
  readonly redactedHeaderNames: readonly string[]
}

const OPENAI_TEXT = [
  'data: {"type":"response.created","response":{"id":"r1"}}',
  'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
  'data: {"type":"response.output_text.delta","item_id":"i1","delta":"ok"}',
  'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message","content":[{"type":"output_text","text":"ok"}]}}',
]

const GEMINI_TEXT = [
  'event: step.start\ndata: {"event_type":"step.start","index":0,"step":{"type":"model_output"}}',
  'event: step.delta\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"ok"}}',
  'event: step.stop\ndata: {"event_type":"step.stop","index":0}',
]

const ANTHROPIC_TEXT = [
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  'data: {"type":"content_block_stop","index":0}',
]

interface ProviderFixture {
  readonly provider: OracleProvider
  readonly model: string
  readonly completeFrames: readonly string[]
  readonly missingUsageFrames: readonly string[]
  readonly malformedUsageFrames: readonly string[]
  /** Frames with the provider's terminal event removed. */
  readonly truncatedFrames: readonly string[]
  createAdapter(input: OracleAdapterInput): ModelAdapter
}

function codexJwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `e30.${encoded}.signature`
}

/**
 * The four provider fixtures, mirroring the frames their unit suites already use.
 *
 * `codex` receives a non-expiring in-memory token so the recorder never reaches a
 * refresh endpoint; the access token's `exp` is the only value derived from the
 * clock and it never appears in a record.
 */
function providerFixtures(): readonly ProviderFixture[] {
  return Object.freeze([
    Object.freeze({
      provider: 'openai' as const,
      model: 'gpt-conformance',
      completeFrames: [...OPENAI_TEXT,
        'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}'],
      missingUsageFrames: [...OPENAI_TEXT,
        'data: {"type":"response.completed","response":{"id":"r1"}}'],
      malformedUsageFrames: [...OPENAI_TEXT,
        'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":1}}}'],
      truncatedFrames: OPENAI_TEXT,
      createAdapter: (input: OracleAdapterInput) => openAiAdapter({
        apiKey: 'private-openai-key', ...input,
      }),
    }),
    Object.freeze({
      provider: 'gemini' as const,
      model: 'gemini-conformance',
      completeFrames: [...GEMINI_TEXT,
        'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed","usage":{"total_input_tokens":3,"total_output_tokens":2,"total_tokens":5}}}'],
      missingUsageFrames: [...GEMINI_TEXT,
        'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed"}}'],
      malformedUsageFrames: [...GEMINI_TEXT,
        'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed","usage":{"total_input_tokens":3,"total_output_tokens":2,"total_tokens":1}}}'],
      truncatedFrames: GEMINI_TEXT,
      createAdapter: (input: OracleAdapterInput) => geminiAdapter({
        apiKey: 'private-gemini-key', ...input,
      }),
    }),
    Object.freeze({
      provider: 'anthropic' as const,
      model: 'claude-conformance',
      completeFrames: [
        'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}}',
        ...ANTHROPIC_TEXT,
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        'data: {"type":"message_stop"}',
      ],
      missingUsageFrames: [
        'data: {"type":"message_start","message":{"id":"m1"}}',
        ...ANTHROPIC_TEXT,
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        'data: {"type":"message_stop"}',
      ],
      malformedUsageFrames: [
        'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":"private-invalid-counter"}}}',
        ...ANTHROPIC_TEXT,
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        'data: {"type":"message_stop"}',
      ],
      truncatedFrames: [
        'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}}',
        ...ANTHROPIC_TEXT,
      ],
      createAdapter: (input: OracleAdapterInput) => anthropicAdapter({
        apiKey: 'private-anthropic-key', ...input,
      }),
    }),
    Object.freeze({
      provider: 'codex' as const,
      model: 'gpt-codex-conformance',
      completeFrames: [...OPENAI_TEXT,
        'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}'],
      missingUsageFrames: [...OPENAI_TEXT,
        'data: {"type":"response.completed","response":{"id":"r1"}}'],
      malformedUsageFrames: [...OPENAI_TEXT,
        'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":1}}}'],
      truncatedFrames: OPENAI_TEXT,
      createAdapter: (input: OracleAdapterInput) => codexAdapter({
        authStore: memoryCodexAuthStore({
          tokens: {
            id_token: codexJwt({}),
            access_token: codexJwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
            refresh_token: 'private-refresh-token',
          },
        }),
        ...input,
      }),
    }),
  ])
}

/** Every provider/scenario pair the oracle covers, in stable order. */
export function generationOracleCases(): readonly OracleCase[] {
  const cases: OracleCase[] = []
  for (const fixture of providerFixtures()) {
    const base = { provider: fixture.provider, model: fixture.model, createAdapter: fixture.createAdapter }
    cases.push(
      { ...base, scenario: 'complete', frames: fixture.completeFrames, maxSseEvents: 100 },
      { ...base, scenario: 'missing-usage', frames: fixture.missingUsageFrames, maxSseEvents: 100 },
      { ...base, scenario: 'malformed-usage', frames: fixture.malformedUsageFrames, maxSseEvents: 100 },
      // The bound is deliberately below the fixture's frame count.
      { ...base, scenario: 'stream-bound-failure', frames: fixture.completeFrames, maxSseEvents: 1 },
      { ...base, scenario: 'truncated-stream', frames: fixture.truncatedFrames, maxSseEvents: 100 },
      { ...base, scenario: 'media-type-invalid', maxSseEvents: 100 },
      { ...base, scenario: 'http-error', maxSseEvents: 100 },
      // The only case that records a `dispatchState` other than `sent`.
      { ...base, scenario: 'transport-failure', maxSseEvents: 100 },
    )
  }
  return Object.freeze(cases.map(entry => Object.freeze(entry)))
}

/** Stable on-disk name for one recorded case. */
export function oracleFileName(entry: Pick<OracleCase, 'provider' | 'scenario'>): string {
  return `${entry.provider}.${entry.scenario}.json`
}

function sseResponse(frames: readonly string[]): Response {
  const encoded = new TextEncoder().encode(`${frames.join('\n\n')}\n\n`)
  return new Response(encoded, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function scenarioFetch(entry: OracleCase): typeof globalThis.fetch {
  if (entry.scenario === 'transport-failure') {
    // Rejecting before any response exists is what leaves the attempt's dispatch
    // state indeterminate, which is exactly the fact this case freezes.
    return () => Promise.reject(new TypeError('private oracle network failure'))
  }
  return () => Promise.resolve(scenarioResponse(entry))
}

function scenarioResponse(entry: OracleCase): Response {
  if (entry.scenario === 'media-type-invalid') {
    return new Response('{"ok":true}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  if (entry.scenario === 'http-error') {
    return new Response('{"error":{"message":"private oracle failure"}}', {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'retry-after': '2',
        'x-request-id': 'oracle-request-id',
      },
    })
  }
  return sseResponse(entry.frames ?? [])
}

interface AttemptLedger {
  readonly attempts: OracleAttemptRecord[]
  endCalls: number
}

/**
 * Attempt accounting that records what the transport reports without altering it.
 *
 * `end()` has to return an {@link AttemptUsageReport}, so the handle synthesizes a
 * minimal one; none of its clock-derived fields are recorded.
 */
function recordingContext(ledger: AttemptLedger): ModelInvocationContext {
  return {
    declareProviderAttemptAccounting: () => undefined,
    startProviderAttempt: (input: StartProviderAttemptInput) => {
      const attemptNumber = ledger.attempts.length + 1
      const handle: ProviderAttemptHandle = {
        attemptId: `oracle-attempt-${attemptNumber}`,
        attemptNumber,
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        end: (outcome: EndProviderAttemptInput): AttemptUsageReport => {
          ledger.endCalls++
          ledger.attempts.push(Object.freeze({
            attemptNumber,
            method: input.method,
            origin: input.origin,
            status: outcome.status,
            dispatchState: outcome.dispatchState,
            ...outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus },
            ...outcome.providerRequestId === undefined
              ? {}
              : { providerRequestId: outcome.providerRequestId },
            ...outcome.error?.code === undefined ? {} : { errorCode: outcome.error.code },
          }))
          return {
            attemptId: `oracle-attempt-${attemptNumber}`,
            spanId: 'b7ad6b7169203331' as AttemptUsageReport['spanId'],
            attemptNumber,
            status: outcome.status,
            startedAt: '1970-01-01T00:00:00.000Z',
            endedAt: '1970-01-01T00:00:00.000Z',
            durationMs: 0,
            dispatchState: outcome.dispatchState,
            coverage: 'not-applicable',
            reported: {},
          }
        },
      }
      return Promise.resolve(handle)
    },
  }
}

/** Reduce one chunk to the facts that constitute observable protocol behaviour. */
function normalizeChunk(chunk: StreamChunk): unknown {
  if (chunk.type !== 'finish') return chunk
  const reason = chunk.reason
  if (reason.kind !== 'error' && reason.kind !== 'aborted') {
    return { type: 'finish', reason: { kind: reason.kind } }
  }
  return {
    type: 'finish',
    reason: {
      kind: reason.kind,
      failure: {
        code: reason.failure.code,
        ...reason.failure.status === undefined ? {} : { status: reason.failure.status },
      },
    },
  }
}

function failureCode(error: unknown): string {
  const carried = error as { readonly code?: unknown; readonly failure?: { readonly code?: unknown } }
  if (typeof carried?.code === 'string') return carried.code
  if (typeof carried?.failure?.code === 'string') return carried.failure.code
  return 'UNKNOWN'
}

function thrownRecord(error: unknown): OracleThrownRecord {
  const failure = (error as { readonly failure?: {
    readonly code?: unknown
    readonly status?: unknown
    readonly providerRetryAfterMs?: unknown
    readonly requestId?: unknown
  } }).failure
  return {
    code: failureCode(error),
    ...typeof failure?.status === 'number' ? { status: failure.status } : {},
    ...typeof failure?.providerRetryAfterMs === 'number'
      ? { providerRetryAfterMs: failure.providerRetryAfterMs }
      : {},
    ...typeof failure?.requestId === 'string' ? { requestId: failure.requestId } : {},
  }
}

/**
 * Replay one case and reduce it to a record.
 *
 * The recorder never touches provider internals: it injects `fetch`, observes the
 * redacted wire headers through the public request logger, and drains
 * `adapter.stream()` exactly once.
 */
export async function recordGenerationOracleCase(entry: OracleCase): Promise<OracleRecord> {
  const ledger: AttemptLedger = { attempts: [], endCalls: 0 }
  let observedHeaders: Readonly<Record<string, string>> = {}
  const adapter = entry.createAdapter({
    models: [{ id: entry.model, name: entry.model }],
    maxSseEvents: entry.maxSseEvents,
    requestLogger: record => { observedHeaders = record.headers },
    fetch: scenarioFetch(entry),
  })

  const chunks: unknown[] = []
  const errorCodes = new Set<string>()
  let thrown: OracleThrownRecord | undefined
  try {
    for await (const chunk of adapter.stream({
      provider: entry.provider,
      model: entry.model,
      messages: [],
    }, recordingContext(ledger))) {
      chunks.push(normalizeChunk(chunk))
      if (chunk.type === 'finish'
        && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        errorCodes.add(chunk.reason.failure.code)
      }
    }
  } catch (error: unknown) {
    thrown = thrownRecord(error)
    errorCodes.add(thrown.code)
  }
  for (const attempt of ledger.attempts) {
    if (attempt.errorCode !== undefined) errorCodes.add(attempt.errorCode)
  }

  const headerNames = Object.keys(observedHeaders).sort()
  return {
    schemaVersion: GENERATION_ORACLE_VERSION,
    provider: entry.provider,
    scenario: entry.scenario,
    model: entry.model,
    chunks,
    errorCodes: [...errorCodes].sort(),
    ...thrown === undefined ? {} : { thrown },
    attempts: ledger.attempts,
    attemptEndCalls: ledger.endCalls,
    requestHeaderNames: headerNames,
    redactedHeaderNames: headerNames.filter(name => observedHeaders[name] === '[REDACTED]'),
  }
}

/** Replay every case in stable order. */
export async function recordGenerationOracle(): Promise<readonly OracleRecord[]> {
  const records: OracleRecord[] = []
  for (const entry of generationOracleCases()) {
    records.push(await recordGenerationOracleCase(entry))
  }
  return records
}

/** Serialize a record deterministically: sorted keys, trailing newline. */
export function serializeOracleRecord(record: OracleRecord): string {
  return `${JSON.stringify(record, sortedKeysReplacer, 2)}\n`
}

function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) sorted[key] = source[key]
  return sorted
}
