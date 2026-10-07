import type { OpenAiEmbeddingProviderOptions } from './embedding-types.ts'
export type { OpenAiEmbeddingProviderOptions } from './embedding-types.ts'
/**
 * The OpenAI embeddings endpoint: `POST {baseUrl}/embeddings`.
 *
 * Deliberately a separate module from {@link ./adapter.ts}: it shares no protocol,
 * no dialect and no request vocabulary with `openAiResponsesProtocol`, and wiring
 * embedding through the generation pipeline would mean one of the two shapes
 * standing in for the other (Requirement 14.1). What the two DO share is the
 * transport — the fused signal, the redirect guard, the attempt ledger, the
 * attribution headers — because that chain is where a missing step is expensive.
 *
 * Three facts about this endpoint decide most of what is here, and each has a
 * plausible-looking wrong answer:
 *
 * - **There is no purpose parameter.** A route declares
 *   `purposeHandling: 'unsupported'` and this adapter sends the caller's text
 *   verbatim. Inventing a `"query: "` prefix would change every vector the caller
 *   gets while looking like a helpful default (Requirement 7.5).
 * - **There is no truncation parameter.** `truncation: 'allow'` is therefore
 *   refused with `EMBEDDING_TRUNCATION_UNSUPPORTED` rather than accepted and
 *   quietly not honoured (Requirement 9.7).
 * - **`dimensions` is a model-line capability, not an endpoint one.** It goes on
 *   the wire only when the route DECLARES the widths it supports; an `unknown`
 *   catalog is not a licence to send a parameter an endpoint may reject
 *   (Requirement 14.4).
 *
 * `baseUrl` is configurable because a self-hosted OpenAI-compatible endpoint is
 * the only mechanism this needs (Requirement 15.1). What it is NOT is an
 * inference: compatibility is a profile someone declared through
 * `EmbeddingCatalogModel`, never something read off the path, and a cleartext
 * `http://` base still requires `allowInsecureHttp` (Requirements 15.3, 15.5).
 *
 * @module ai-agent-sdk/providers/openai/embedding
 */

import {
  EMBEDDING_ERROR_CODES,
  EmbeddingError,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  type CredentialInput,
  type ModelInvocationContext,
  type SdkLogger,
} from '@alvin0/ai-agent-sdk-core/provider'

const DISPLAY_NAME = 'OpenAI'

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

/** Resolves a literal key or a credential source, once per operation. */
export async function resolveApiKey(
  apiKey: CredentialInput,
  signal?: AbortSignal,
  context?: ModelInvocationContext,
): Promise<string> {
  const value = typeof apiKey === 'string'
    ? apiKey
    : await apiKey.resolve({
      signal: signal ?? NEVER_ABORTED_SIGNAL,
      logger: context?.logger ?? NULL_LOGGER,
    })
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EmbeddingError(
      `${DISPLAY_NAME} embeddings requires a non-empty \`apiKey\``,
      EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
    )
  }
  return value
}

export function embeddingTransportOptions(options: OpenAiEmbeddingProviderOptions) {
  return {
      ...(options.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: options.allowInsecureHttp }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.maxRequestBytes === undefined
        ? {}
        : { maxRequestBytes: options.maxRequestBytes }),
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
      ...(options.maxResponseChunks === undefined
        ? {}
        : { maxResponseChunks: options.maxResponseChunks }),
      ...(options.maxErrorBodyBytes === undefined
        ? {}
        : { maxErrorBodyBytes: options.maxErrorBodyBytes }),
      ...(options.requestLoggerTimeoutMs === undefined
        ? {}
        : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }
}
