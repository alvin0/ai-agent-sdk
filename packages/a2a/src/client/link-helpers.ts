import {
  ClientFactory,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client'
import type { SupportSafeError } from '@alvin0/ai-agent-sdk-core'
import type { A2AAgentLinkOptions, A2AUnlinkReport } from './types.ts'
import { cleanupFailure } from '../common/cleanup-report.ts'

export function unlinkReport(
  status: A2AUnlinkReport['status'],
  alreadyUnlinked: boolean,
  error: SupportSafeError | undefined = status === 'failed'
    ? cleanupFailure('A2A_UNLINK_FAILED', 'a2a-unlink', 'A2A link removal failed')
    : undefined,
): A2AUnlinkReport {
  return Object.freeze({ status, alreadyUnlinked, ...(error === undefined ? {} : { error }) })
}

export function defaultFactory(options: A2AAgentLinkOptions): ClientFactory {
  const transportOptions = {
    ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
    legacyCompat: { enabled: options.legacyCompat ?? false },
  }
  return new ClientFactory({
    transports: [
      new JsonRpcTransportFactory(transportOptions),
      new RestTransportFactory(transportOptions),
    ],
  })
}
