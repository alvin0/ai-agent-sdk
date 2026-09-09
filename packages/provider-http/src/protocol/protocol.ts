/**
 * A wire protocol, separated from the endpoint that speaks it.
 *
 * This split is what makes adding a provider cheap. "Which JSON shapes and SSE
 * events" is a PROTOCOL concern; "which URL, which credential, which models" is an
 * ENDPOINT concern. Dozens of endpoints speak the protocols this package
 * implements, so an endpoint that speaks one should be expressible as data rather
 * than as another adapter class.
 *
 * A protocol object owns no endpoint, no credential, and no state. It is a pure
 * translation pair plus the small amount of metadata the pipeline needs.
 *
 * @module ai-agent-sdk/providers/protocols/protocol
 */

import type { SseEvent } from '../stream/sse.ts'
import type { ProviderRequest } from '../base/http-adapter.ts'
import type { ProviderProtocolChunk } from '../stream/types.ts'

export { HTTP_PROTOCOL_API_VERSION, HTTP_PROVIDER_ERROR_CODES } from './config.ts'
export { defineWireProtocol } from './definition.ts'
export type {
  HttpAuthResolveOptions,
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
  RuntimeWireProtocol,
  WireProtocolDefinition,
} from './runtime-types.ts'

/** A protocol may report partial/untrusted usage before transport validation. */
export type WireProtocolChunk = ProviderProtocolChunk

/**
 * One wire protocol.
 *
 * `Dialect` is the protocol's own knob record — the per-endpoint variations that
 * change which optional fields are sent without changing any behaviour. Keeping it
 * a type parameter means an endpoint can override exactly the knobs its protocol
 * defines and nothing else.
 */
export interface WireProtocol<Dialect> {
  /** Stable identifier, used in diagnostics and to name the protocol in config. */
  readonly id: string

  /**
   * Knob defaults.
   *
   * An endpoint supplies a partial override, so a new knob can be added to a
   * protocol without touching any endpoint that does not care about it.
   */
  readonly defaultDialect: Dialect

  /** Path appended to the endpoint's base URL. */
  endpointPath(request: ProviderRequest, dialect: Dialect): string

  /**
   * Headers the PROTOCOL requires, as opposed to the ones authentication supplies.
   *
   * `anthropic-version` is the motivating case: it is mandatory on every request
   * to that API regardless of which endpoint or credential is used, so it belongs
   * to the protocol rather than being copied into each endpoint's config.
   */
  protocolHeaders?(dialect: Dialect): Record<string, string>

  /** Normalized request to this protocol's wire JSON. */
  serialize(request: ProviderRequest, dialect: Dialect): unknown | Promise<unknown>

  /**
   * This protocol's SSE events to the SDK's chunk protocol.
   *
   * Owns termination: it decides what ends the stream and must raise
   * `STREAM_CLOSED` when the body ends before the provider said it was finished.
   */
  translate(
    events: AsyncIterable<SseEvent>,
    request: ProviderRequest,
    displayName: string,
  ): AsyncGenerator<WireProtocolChunk>
}

/** Any protocol, when the dialect type does not matter to the holder. */
export type AnyWireProtocol = WireProtocol<never>

/**
 * Merge an endpoint's partial dialect over a protocol's defaults.
 *
 * `undefined` entries are dropped rather than applied, so an override object built
 * with optional fields cannot accidentally erase a default.
 * @param protocol - the protocol supplying defaults.
 * @param overrides - the endpoint's partial override.
 * @returns the effective, frozen dialect.
 */
export function resolveDialect<Dialect extends object>(
  protocol: WireProtocol<Dialect>,
  overrides: Partial<Dialect> | undefined,
): Dialect {
  if (overrides === undefined) return protocol.defaultDialect
  const applied = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<Dialect>
  return Object.freeze({ ...protocol.defaultDialect, ...applied })
}
