import type { ContentBlock, Message } from '@ai-agent-sdk/core'
import type { ToolExecutionResult } from '@ai-agent-sdk/core/agent'
import { MAX_SKILL_ID_CHARS, SKILL_ID_PATTERN } from '@ai-agent-sdk/core/agent'
import { SKILL_TOOLS, CONTROL_TOOLS, MATERIAL_AGENTCODE_TOOLS, SUCCESSFUL_NATIVE_STATUSES } from './constants.ts'
import type {
  AgentCodeSkillEvidence,
  MutableSkillEvidence,
  SkillEvidenceStatus,
} from './types.ts'
export function freezeEvidence(skill: MutableSkillEvidence): AgentCodeSkillEvidence {
  const status = statusOf(skill)
  return Object.freeze({
    skillId: skill.skillId,
    expected: skill.expected,
    status,
    loadAttempts: skill.loadAttempts,
    successfulLoads: skill.successfulLoads,
    failedLoads: skill.failedLoads,
    instructionExposureRequests: skill.instructionExposureRequests,
    resourceAttempts: skill.resourceAttempts,
    successfulResourceCalls: skill.successfulResourceCalls,
    resourceExposureRequests: skill.resourceExposureRequests,
    successfulApplicationActions: skill.successfulApplicationActions,
    failedApplicationAttempts: skill.failedApplicationAttempts,
    resourceInformedActions: skill.resourceInformedActions,
    activationIoEvents: skill.activationIoEvents,
    activationBytesRead: skill.activationBytesRead,
    resourceIoEvents: skill.resourceIoEvents,
    resourceBytesRead: skill.resourceBytesRead,
    applicationTools: Object.freeze([...skill.applicationTools].sort()),
    ...(skill.firstLoadSequence === undefined ? {} : { firstLoadSequence: skill.firstLoadSequence }),
    ...(skill.firstInstructionExposureSequence === undefined
      ? {} : { firstInstructionExposureSequence: skill.firstInstructionExposureSequence }),
    ...(skill.firstApplicationSequence === undefined
      ? {} : { firstApplicationSequence: skill.firstApplicationSequence }),
  })
}

export function statusOf(skill: MutableSkillEvidence): SkillEvidenceStatus {
  if (skill.resourceInformedActions > 0) return 'resource-informed'
  if (skill.successfulApplicationActions > 0) return 'behaviorally-applied'
  if (skill.instructionExposureRequests > 0) return 'instructions-in-context'
  if (skill.successfulLoads > 0) return 'loaded'
  if (skill.failedLoads > 0) return 'load-failed'
  return 'not-loaded'
}

export function isApplied(status: SkillEvidenceStatus): boolean {
  return status === 'behaviorally-applied' || status === 'resource-informed'
}

export function isApplicationTool(toolName: string): boolean {
  if (SKILL_TOOLS.has(toolName) || CONTROL_TOOLS.has(toolName)) return false
  return MATERIAL_AGENTCODE_TOOLS.has(toolName)
}

export function isSuccessfulApplicationResult(
  toolName: string,
  result: ToolExecutionResult,
): boolean {
  if (result.isError) return false
  if (toolName !== 'run_command') return true
  if (result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
    return false
  }
  const value = result.value as Readonly<Record<string, unknown>>
  const didNotTimeOut = value.timedOut === undefined || value.timedOut === false
  return value.exitCode === 0 && didNotTimeOut
}

export function isSuccessfulNativeStatus(status: string | undefined): boolean {
  return status !== undefined && SUCCESSFUL_NATIVE_STATUSES.has(status.trim().toLocaleLowerCase('en-US'))
}

export function skillIdFromMeta(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const skillId = (meta as Record<string, unknown>).skillId
  return typeof skillId === 'string' ? skillId : undefined
}

export function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch { return undefined }
}

interface ToolResultInspection {
  textChars: number
  skillMarkers: Set<string>
}

export function inspectModelMessages(messages: readonly Message[]): {
    toolResults: Map<string, ToolResultInspection>
    skillMarkers: Set<string>
  } {
  const toolResults = new Map<string, ToolResultInspection>()
  const skillMarkers = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      let textChars = 0
      const markers = new Set<string>()
      visitText(block.content, text => {
        textChars += text.length
        for (const id of skillMarkersOf(text)) {
          markers.add(id)
          skillMarkers.add(id)
        }
      })
      toolResults.set(String(block.toolCallId), { textChars, skillMarkers: markers })
    }
  }
  return { toolResults, skillMarkers }
}

function visitText(
  blocks: readonly ContentBlock[],
  visit: (text: string) => void,
  depth = 0,
): void {
  if (depth >= 6) return
  for (const block of blocks.slice(0, 1_000)) {
    if (block.type === 'text' || block.type === 'reasoning') visit(block.text)
    else if (block.type === 'tool-result') visitText(block.content, visit, depth + 1)
    else if (block.type === 'native-tool-call') visitText(block.content, visit, depth + 1)
  }
}

export function skillMarkersOf(text: string): readonly string[] {
  const ids: string[] = []
  const pattern = /<skill_content\s+id="([^"]+)">/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null && ids.length < 128) {
    const id = match[1] === undefined ? undefined : sanitizeSkillId(match[1])
    if (id !== undefined) ids.push(id)
  }
  return ids
}

export function sanitizeSkillId(input: string): string | undefined {
  return input.length <= MAX_SKILL_ID_CHARS && SKILL_ID_PATTERN.test(input)
    ? input
    : undefined
}

export function redact(input: string, maxChars: number): string {
  const redacted = input
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu, 'Bearer <redacted>')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}/giu, '<redacted-token>')
    .replace(/([?&](?:api[_-]?key|key|token|secret|password)=)[^&\s]+/giu, '$1<redacted>')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/giu, '$1<redacted>')
  return redacted.length <= maxChars
    ? redacted
    : `${redacted.slice(0, Math.max(0, maxChars - 24))}... <${redacted.length} chars>`
}

export function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

export function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export function addRecent(set: Set<string>, value: string, limit: number): void {
  set.delete(value)
  set.add(value)
  if (set.size <= limit) return
  const oldest = set.values().next().value as string | undefined
  if (oldest !== undefined) set.delete(oldest)
}

export function stripUndefined(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}
