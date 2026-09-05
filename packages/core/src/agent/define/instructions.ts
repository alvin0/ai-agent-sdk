import { AgentSdkError } from '../../errors/agent-sdk-error.ts'

export const RUN_ADDITIONAL_INSTRUCTIONS_MAX_BYTES = 65_536
export const RUN_ADDITIONAL_INSTRUCTIONS_INVALID = 'RUN_ADDITIONAL_INSTRUCTIONS_INVALID'

/** Capture the exact host-owned overlay; accepted text is never trimmed or rewritten. */
export function captureAdditionalInstructions(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0
    || new TextEncoder().encode(value).byteLength > RUN_ADDITIONAL_INSTRUCTIONS_MAX_BYTES) {
    throw new AgentSdkError('Run additional instructions are invalid', RUN_ADDITIONAL_INSTRUCTIONS_INVALID)
  }
  return value
}

export function appendRunInstructions(system: string, overlay?: string): string {
  return overlay === undefined ? system : `${system}\n\n${overlay}`
}
