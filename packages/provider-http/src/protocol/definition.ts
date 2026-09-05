import {
  boundedIdentifier,
  capturedMethod,
  optionalCapturedMethod,
  ownData,
  plainObject,
} from '../common/data.ts'
import { snapshotJsonObject } from '../common/json-snapshot.ts'
import { HTTP_PROTOCOL_API_VERSION, HTTP_PROTOCOL_LIMITS } from './config.ts'
import type {
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
  RuntimeWireProtocol,
  WireProtocolDefinition,
} from './runtime-types.ts'

/**
 * Stamp a protocol definition without allocating transport state or performing I/O.
 * All executable properties are captured once and retain the author's receiver.
 */
export function defineWireProtocol<Dialect extends object>(
  definition: WireProtocolDefinition<Dialect>,
): RuntimeWireProtocol<Dialect> {
  const source = plainObject(definition, 'wire protocol definition')
  const id = boundedIdentifier(ownData(source, 'id'), HTTP_PROTOCOL_LIMITS.idBytes, 'protocol id')
  const defaultDialect = snapshotJsonObject(ownData(source, 'defaultDialect'), {
    maxDepth: HTTP_PROTOCOL_LIMITS.dialectDepth,
    maxNodes: HTTP_PROTOCOL_LIMITS.dialectNodes,
    maxObjectFields: HTTP_PROTOCOL_LIMITS.dialectObjectFields,
    maxArrayItems: HTTP_PROTOCOL_LIMITS.dialectArrayItems,
    maxKeyBytes: HTTP_PROTOCOL_LIMITS.dialectKeyBytes,
    maxBytes: HTTP_PROTOCOL_LIMITS.dialectBytes,
  }) as Dialect
  const endpointPath = capturedMethod<[ProtocolRequest, Dialect], string>(source, 'endpointPath')
  const protocolHeaders = optionalCapturedMethod<[Dialect], Readonly<Record<string, string>>>(
    source,
    'protocolHeaders',
  )
  const serialize = capturedMethod<
    [ProtocolRequest, Dialect], Readonly<Record<string, unknown>>
  >(source, 'serialize')
  const translate = capturedMethod<
    [AsyncIterable<ProtocolSseEvent>, ProtocolRequest, string],
    AsyncGenerator<ProtocolStreamChunk>
  >(source, 'translate')

  return Object.freeze({
    kind: 'http-wire-protocol' as const,
    apiVersion: HTTP_PROTOCOL_API_VERSION,
    id,
    defaultDialect,
    endpointPath,
    ...(protocolHeaders === undefined ? {} : { protocolHeaders }),
    serialize,
    translate,
  })
}
