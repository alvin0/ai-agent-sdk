import type { SupportSafeError } from '@ai-agent-sdk/core'

const NO_USAGE = Object.freeze({ logicalCalls: 0, attempts: 0, complete: 0, partial: 0,
  estimated: 0, missing: 0, notApplicable: 0, possiblyBilledAttemptsWithoutUsage: 0 })

export function mcpSupportError(code: string, stage: string, message: string): SupportSafeError {
  return Object.freeze({ code, stage, message, usageCoverage: NO_USAGE,
    possiblyBilledAttemptsWithoutUsage: 0 })
}
