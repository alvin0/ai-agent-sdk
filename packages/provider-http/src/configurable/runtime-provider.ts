import {
  AgentSdkError,
  CREDENTIAL_CAPABILITY_API_VERSION,
  type CredentialOperationOptions,
  type ModelInvocationContext,
  type SdkLogger,
} from '@alvin0/ai-agent-sdk-core/provider'
import {
  boundedIdentifier,
  capturedMethod,
  optionalCapturedMethod,
  ownData,
  plainObject,
} from '../common/data.ts'
import { HTTP_PROTOCOL_API_VERSION, HTTP_PROVIDER_ERROR_CODES } from '../protocol/config.ts'
import { defineWireProtocol } from '../protocol/definition.ts'
import { DEFAULT_MAX_REQUEST_BYTES, type HttpModelAdapter } from '../base/http-adapter.ts'
import { snapshotWireBody } from '../common/wire-body.ts'
import type {
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
  RuntimeWireProtocol,
} from '../protocol/runtime-types.ts'
import {
  createHttpProvider,
  type AuthScheme,
  type HttpProviderOptions,
  type ModelDiscoveryContext,
} from './http-provider.ts'
import type { RuntimeHttpProviderOptions, RuntimeModelDiscoveryContext } from './runtime-types.ts'
import { snapshotJsonObject } from '../common/json-snapshot.ts'
import { HTTP_RUNTIME_OPTION_LIMITS } from '../common/config.ts'
import { mergeHeaderLayers, type HeaderLayer } from '../common/header-layers.ts'

const NEVER_ABORTED_SIGNAL = new AbortController().signal
const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
})

/** Create the versioned HTTP extension adapter without performing credential or network I/O. */
export function createRuntimeHttpProvider<Dialect extends object>(
  options: RuntimeHttpProviderOptions<Dialect>,
): HttpModelAdapter {
  const source = plainObject(options, 'runtime HTTP provider options')
  const displayName = boundedIdentifier(ownData(source, 'displayName'), 256, 'displayName')
  const baseUrl = captureBaseUrl(ownData(source, 'baseUrl'))
  const protocol = boundedRuntimeProtocol(
    captureRuntimeProtocol<Dialect>(ownData(source, 'protocol')),
  )
  const auth = captureRuntimeAuth(ownData(source, 'auth'), baseUrl)
  const discover = optionalCapturedMethod<
    [RuntimeModelDiscoveryContext], Promise<readonly import('../base/http-adapter.ts').ProviderCatalogModel[]>
  >(source, 'discoverModels')
  const fetch = optionalCapturedMethod<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>(
    source,
    'fetch',
  )
  const describeModel = optionalCapturedMethod<
    [import('@alvin0/ai-agent-sdk-core/provider').ResolvedModelInfo, Dialect],
    import('@alvin0/ai-agent-sdk-core/provider').ResolvedModelInfo
  >(source, 'describeModel')
  const errorCode = optionalCapturedMethod<[number, string], string | undefined>(source, 'errorCode')
  const requestLogger = optionalCapturedMethod<
    [import('../base/http-adapter.ts').ProviderRequestLogRecord], Promise<void> | void
  >(source, 'requestLogger')
  const headers = captureHeaders(source)

  const legacy: HttpProviderOptions<Dialect> = {
    displayName,
    protocol,
    baseUrl: baseUrl.href,
    auth,
    ...copyOptional(source, 'allowInsecureHttp'),
    ...copyJsonOptional(source, 'models', 'models'),
    ...copyJsonOptional(source, 'dialect', 'dialect'),
    ...(fetch === undefined ? {} : { fetch }),
    ...(headers === undefined ? {} : { headers }),
    ...copyOptional(source, 'catalogTtlMs'),
    ...copyOptional(source, 'catalogStaleTtlMs'),
    ...copyOptional(source, 'catalogFailureBackoffMs'),
    ...copyOptional(source, 'maxCatalogModels'),
    ...copyOptional(source, 'maxCatalogBytes'),
    ...(describeModel === undefined ? {} : { describeModel }),
    ...copyOptional(source, 'defaultMaxTokens'),
    ...copyOptional(source, 'defaultContextWindow'),
    ...copyOptional(source, 'streamIdleTimeoutMs'),
    ...copyOptional(source, 'requestTimeoutMs'),
    ...copyOptional(source, 'maxRequestBytes'),
    ...copyOptional(source, 'maxResponseBytes'),
    ...copyOptional(source, 'maxResponseChunks'),
    ...copyOptional(source, 'maxSseEvents'),
    ...copyOptional(source, 'maxSseEventChars'),
    ...copyOptional(source, 'maxErrorBodyBytes'),
    ...copyOptional(source, 'requestLoggerTimeoutMs'),
    ...copyJsonOptional(source, 'retryPolicy', 'retryPolicy'),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...copyHeaderOptional(source, 'baseHeaders', 'transport'),
    ...(requestLogger === undefined ? {} : { requestLogger }),
    ...(discover === undefined ? {} : {
      discoverModels: async (context: ModelDiscoveryContext) => discover({
        provider: context.provider ?? '',
        baseUrl: new URL(context.baseUrl),
        headers: context.headers,
        signal: context.signal ?? NEVER_ABORTED_SIGNAL,
        ...(context.context === undefined ? {} : { context: context.context }),
      }),
    }),
  }
  return createHttpProvider(legacy)
}

function boundedRuntimeProtocol<Dialect extends object>(
  protocol: RuntimeWireProtocol<Dialect>,
): RuntimeWireProtocol<Dialect> {
  return Object.freeze({
    ...protocol,
    serialize(request: ProtocolRequest, dialect: Dialect) {
      return snapshotWireBody(
        protocol.serialize(request, dialect),
        request.connection.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      )
    },
  })
}

function captureRuntimeProtocol<Dialect extends object>(value: unknown): RuntimeWireProtocol<Dialect> {
  try {
    const source = plainObject(value, 'runtime wire protocol')
    if (ownData(source, 'kind') !== 'http-wire-protocol'
      || ownData(source, 'apiVersion') !== HTTP_PROTOCOL_API_VERSION) {
      throw new TypeError('unsupported protocol marker')
    }
    const endpointPath = capturedMethod<[ProtocolRequest, Dialect], string>(source, 'endpointPath')
    const protocolHeaders = optionalCapturedMethod<
      [Dialect], Readonly<Record<string, string>>
    >(source, 'protocolHeaders')
    const serialize = capturedMethod<
      [ProtocolRequest, Dialect], Readonly<Record<string, unknown>>
    >(source, 'serialize')
    const translate = capturedMethod<
      [AsyncIterable<ProtocolSseEvent>, ProtocolRequest, string], AsyncGenerator<ProtocolStreamChunk>
    >(source, 'translate')
    return defineWireProtocol({
      id: ownData(source, 'id') as string,
      defaultDialect: ownData(source, 'defaultDialect') as Dialect,
      endpointPath,
      ...(protocolHeaders === undefined ? {} : { protocolHeaders }),
      serialize,
      translate,
    })
  } catch (error) {
    throw new AgentSdkError(
      'Runtime HTTP protocol is incompatible',
      HTTP_PROVIDER_ERROR_CODES.PROTOCOL_API_UNSUPPORTED,
      { cause: error },
    )
  }
}

function captureRuntimeAuth(value: unknown, baseUrl: URL): AuthScheme {
  const source = plainObject(value, 'runtime HTTP auth')
  const kind = ownData(source, 'kind')
  if (kind === 'none') return Object.freeze({ kind })
  if (kind === 'bearer') {
    return Object.freeze({
      kind,
      token: captureCredential(ownData(source, 'token')),
      ...copyOptional(source, 'label'),
    })
  }
  if (kind === 'header') {
    const name = boundedIdentifier(ownData(source, 'name'), 256, 'auth header name')
    return Object.freeze({
      kind,
      name,
      value: captureCredential(ownData(source, 'value')),
      ...copyOptional(source, 'label'),
    })
  }
  if (kind === 'dynamic') {
    const resolve = capturedMethod<
      [import('../protocol/runtime-types.ts').HttpAuthResolveOptions],
      Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>
    >(source, 'resolve')
    return Object.freeze({
      kind,
      resolve: async (
        signal?: AbortSignal,
        context?: ModelInvocationContext,
        provider = '',
      ) => ({
        ...await resolve({
          provider,
          baseUrl,
          signal: signal ?? NEVER_ABORTED_SIGNAL,
          ...(context === undefined ? {} : { context }),
        }),
      }),
    })
  }
  throw new AgentSdkError('Runtime HTTP auth is invalid', HTTP_PROVIDER_ERROR_CODES.HEADER_INVALID)
}

function captureCredential(input: unknown): string | ((
  signal?: AbortSignal,
  context?: ModelInvocationContext,
) => string | Promise<string>) {
  if (typeof input === 'string') return input
  // auth-node's envCredential intentionally retains its historical callable
  // surface while carrying the current credential-source capability fields.
  // Capture those fields exactly like a plain source object; never invoke the
  // callable compatibility view during provider construction.
  const source = typeof input === 'function'
    ? input
    : plainObject(input, 'credential source')
  if (ownData(source, 'kind') !== 'credential-source'
    || ownData(source, 'apiVersion') !== CREDENTIAL_CAPABILITY_API_VERSION) {
    throw new AgentSdkError('Credential source is incompatible', 'CREDENTIAL_SOURCE_INVALID')
  }
  const resolve = capturedMethod<
    [CredentialOperationOptions], string | Promise<string>
  >(source, 'resolve')
  return (signal, context) => resolve({
    signal: signal ?? NEVER_ABORTED_SIGNAL,
    logger: context?.logger ?? NULL_LOGGER,
  })
}

function captureBaseUrl(value: unknown): URL {
  if (value instanceof URL) return new URL(value.href)
  if (typeof value === 'string') return new URL(value)
  throw new TypeError('baseUrl must be an absolute URL or URL string')
}

function copyOptional(source: object, key: string): Record<string, unknown> {
  const value = ownData(source, key, false)
  return value === undefined ? {} : { [key]: value }
}

function copyJsonOptional(source: object, key: string, envelopeKey: string): Record<string, unknown> {
  const value = ownData(source, key, false)
  if (value === undefined) return {}
  const snapshot = snapshotJsonObject({ [envelopeKey]: value }, HTTP_RUNTIME_OPTION_LIMITS)
  return { [key]: snapshot[envelopeKey] }
}

function copyHeaderOptional(
  source: object,
  key: string,
  layer: HeaderLayer,
): Record<string, unknown> {
  const value = ownData(source, key, false)
  return value === undefined ? {} : { [key]: snapshotHeaders(value, layer) }
}

function captureHeaders(
  source: object,
): Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>) | undefined {
  const value = ownData(source, 'headers', false)
  if (value === undefined) return undefined
  if (typeof value !== 'function') return snapshotHeaders(value, 'endpoint')
  const captured = (...args: []) => Reflect.apply(value, source, args) as unknown
  return () => snapshotHeaders(captured(), 'endpoint')
}

function snapshotHeaders(value: unknown, layer: HeaderLayer): Readonly<Record<string, string>> {
  return mergeHeaderLayers([{ layer, headers: value as Readonly<Record<string, string>> }]).headers
}
