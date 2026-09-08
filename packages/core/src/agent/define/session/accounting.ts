import type { AgentDefinition } from '../definition.ts'
import type { AgentRuntimeLimits, AgentSessionOptions } from './types.ts'
import type { RuntimeSessionConfiguration } from './runtime-binding.ts'
import { RunLedger } from '../../accounting/ledger.ts'

export interface SessionLedgerInput {
  readonly definition: AgentDefinition
  readonly options: AgentSessionOptions
  readonly runtimeLimits: Readonly<AgentRuntimeLimits>
  readonly conversationId: string
  readonly runtime?: RuntimeSessionConfiguration
}

export function createSessionLedger(input: SessionLedgerInput): RunLedger {
  const { definition, options, runtimeLimits, conversationId, runtime } = input
  return new RunLedger({
    ...options.observation === undefined ? {} : { observation: options.observation },
    ...options.observationResource === undefined ? {} : { resource: options.observationResource },
    conversationId,
    sessionId: conversationId,
    agentId: definition.id,
    mode: definition.mode,
    maxTurns: definition.maxTurns,
    ...options.usagePolicy === undefined ? {} : { usagePolicy: options.usagePolicy },
    cumulativeTokenBudget: typeof runtimeLimits.maxTotalTokens === 'number',
    ...(runtime?.logger === undefined ? {} : { logger: runtime.logger }),
    ...options.ledgerLimits === undefined ? {} : { limits: options.ledgerLimits },
  })
}
