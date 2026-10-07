import {
  Client,
  InsufficientScopeError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type Transport,
} from '@modelcontextprotocol/client'
import { beginIntegrationOperation, integrationErrorCode } from '../common/integration-operation.ts'
import { errorOf } from './runtime-helpers.ts'
import type { McpConnectionHost, OAuthCapableTransport } from './connection-host.ts'

function isOAuthCapableTransport(transport: Transport | undefined): transport is OAuthCapableTransport {
  return transport instanceof StreamableHTTPClientTransport || transport instanceof SSEClientTransport
}

export function logAuthenticationSuccess(host: McpConnectionHost): void {
  if (host.authenticationKind !== 'none' && host.authenticationKind !== 'unknown') {
    const authentication = beginIntegrationOperation(
      host.options.logger, host.integrationFamily, 'authenticate',
    )
    authentication.attempt(1).success()
    authentication.success()
  }
}

export async function handleConnectAuthorization(host: McpConnectionHost,
  generation: Client, transport: Transport | undefined, context: {
    error: unknown; failure: Error; operation: ReturnType<typeof beginIntegrationOperation>
  },
): Promise<void> {
  const { error, failure, operation } = context
  if (!UnauthorizedError.isInstance(error)) return

  if (host.authenticationKind === 'oauth' && isOAuthCapableTransport(transport)) {
    host.pendingAuthorization = { client: generation, transport }
    host.publish('oauth-authorization-required', host.reconnectAttempts, failure, {
      authorization: { kind: 'oauth', reason: 'authorization-code-required' },
    })
    operation.fail(integrationErrorCode(error))
    logAuthenticationFailure(host, error)
    throw failure
  }
  await host.closeGeneration(generation)
  const status = host.authenticationKind === 'bearer' ? 'authentication-failed' : 'authentication-required'
  host.publish(status, host.reconnectAttempts, failure, {
    authorization: {
      kind: host.authenticationKind,
      reason: host.authenticationKind === 'bearer' ? 'invalid-credentials' : 'credentials-required',
    },
  })
  operation.fail(integrationErrorCode(error))
  logAuthenticationFailure(host, error)
  throw failure

}

export async function handleToolAuthorization(
  host: McpConnectionHost, generation: Client, error: unknown): Promise<void> {
  if (InsufficientScopeError.isInstance(error)) {
    host.publish('scope-authorization-required', host.reconnectAttempts, errorOf(error), {
      authorization: {
        kind: host.authenticationKind,
        reason: 'insufficient-scope',
        ...(error.requiredScope === undefined ? {} : { requiredScope: error.requiredScope }),
      },
      ...(host.currentState.protocol === undefined ? {} : { protocol: host.currentState.protocol }),
    })
  } else if (UnauthorizedError.isInstance(error)) {
      await handleUnauthorizedTool(host, generation, error)
    }
}

export async function handleUnauthorizedTool(
  host: McpConnectionHost, generation: Client, error: unknown): Promise<void> {
    const transport = generation.transport
    if (host.current === generation) host.current = undefined
    if (host.authenticationKind === 'oauth' && isOAuthCapableTransport(transport)) {
      host.pendingAuthorization = { client: generation, transport }
      host.publish('oauth-authorization-required', host.reconnectAttempts, errorOf(error), {
        authorization: { kind: 'oauth', reason: 'authorization-code-required' },
        ...(host.currentState.protocol === undefined ? {} : { protocol: host.currentState.protocol }),
      })
    } else {
      await host.closeGeneration(generation)
      host.publish(
        host.authenticationKind === 'bearer' ? 'authentication-failed' : 'authentication-required',
        host.reconnectAttempts,
        errorOf(error),
        {
          authorization: {
            kind: host.authenticationKind,
            reason: host.authenticationKind === 'bearer' ? 'invalid-credentials' : 'credentials-required',
          },
          ...(host.currentState.protocol === undefined ? {} : { protocol: host.currentState.protocol }),
        },
      )
    }

}

export function logAuthenticationFailure(
  host: McpConnectionHost, error: unknown): void {
  const operation = beginIntegrationOperation(host.options.logger, host.integrationFamily, 'authenticate')
  const attempt = operation.attempt(1)
  const code = integrationErrorCode(error)
  attempt.fail(code)
  operation.fail(code)
}
