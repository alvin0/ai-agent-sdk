import type { AgentRunEvent } from '../../agent/mode/run-agent.ts'
import type { CompactionResult } from '../../agent/memory/compaction.ts'
import type { AgentCompactionOptions } from '../../agent/memory/compaction-config.ts'
import type { AgentSessionSnapshot } from '../../agent/define/session/types.ts'
import type { ApprovalBroker, ApprovalRequest } from '../../agent/tool/approval.ts'
import type { ToolDefinition } from '../../agent/tool/definition.ts'
import type { ToolInterceptor } from '../../agent/tool/pipeline.ts'
import type { TurnHooks } from '../../agent/loop/types.ts'
import type { UserInputBroker, UserInputDecision, UserInputRequest } from '../../agent/mode/user-input.ts'
import type { UsagePolicy } from '../../agent/accounting/report.ts'
import type { NativeToolSchema, ToolChoice } from '../../contract/index.ts'
import type { JsonValue } from '../../primitives/index.ts'
import type { ModelTarget } from '../provider/types.ts'
import type { RuntimeRunReport } from '../observation/final-report.ts'
import type { ToolSource } from '../tool-source/types.ts'
import type { MemoryBinding } from '../memory/types.ts'
import type { RuntimeSkillSource } from '../skill-provider/types.ts'

export interface RuntimeAgentDefinitionInput {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly model: ModelTarget
  readonly instructions: string
  readonly effort?: string
  readonly maxTokens?: number
  readonly mode?: 'basic' | 'deep' | 'deep-human-in-loop'
  readonly tools?: readonly ToolDefinition[]
  readonly nativeTools?: readonly NativeToolSchema[]
  readonly toolChoice?: ToolChoice
  readonly toolSources?: readonly ToolSource[]
  readonly skills?: readonly RuntimeSkillSource[]
  readonly allowedSkillIds?: readonly string[]
  readonly memory?: MemoryBinding
  readonly compaction?: AgentCompactionOptions | false
  readonly maxTurns?: number
  readonly maxToolCalls?: number
  readonly commentary?: 'auto' | 'concise' | 'off'
}

export interface RuntimeAgentDefinition extends RuntimeAgentDefinitionInput {}

export interface RuntimeAgentBindingInput extends Omit<RuntimeAgentDefinitionInput, 'model'> {
  readonly model?: { readonly provider: string; readonly id?: string }
}

export interface RuntimeAgentLimits {
  readonly maxSteps?: number
  readonly maxToolCalls?: number
  readonly maxConsecutiveToolErrors?: number
  readonly maxTotalTokens?: number
  readonly observerTimeoutMs?: number
}

export interface RuntimeAgentSessionOptions {
  readonly conversationId?: string
  readonly tools?: readonly ToolDefinition[]
  readonly toolSources?: readonly ToolSource[]
  readonly skills?: readonly RuntimeSkillSource[]
  readonly memory?: MemoryBinding | false
  readonly skillCwd?: string
  readonly userInput?: UserInputBroker
  readonly approvals?: ApprovalBroker
  readonly interceptors?: readonly ToolInterceptor[]
  readonly hooks?: TurnHooks
  readonly usagePolicy?: UsagePolicy
  readonly runtimeLimits?: RuntimeAgentLimits
  readonly compaction?: AgentCompactionOptions | false
}

export interface RuntimeAgentInvocationOptions {
  readonly signal?: AbortSignal
  readonly additionalInstructions?: string
  readonly onEvent?: (event: RuntimeAgentRunEvent) => void | Promise<void>
}

export interface RuntimeAgentRunEventContext {
  readonly runId: string
  readonly traceId: string
  readonly sequence: number
}

export type RuntimeAgentRunEvent = RuntimeAgentRunEventContext & (
  | { readonly type: 'commentary-delta'; readonly text: string }
  | { readonly type: 'assistant-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly callId: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool-result'; readonly callId: string; readonly name: string;
      readonly status: 'completed' | 'failed' | 'aborted' | 'rejected'; readonly output: unknown }
  | { readonly type: 'assistant-native-tool'; readonly callId: string; readonly provider: string;
      readonly name: string; readonly status: 'started' | 'completed' | 'failed' | 'unknown';
      readonly input?: JsonValue; readonly output?: JsonValue }
  | { readonly type: 'approval-request'; readonly request: ApprovalRequest }
  | { readonly type: 'user-input-request'; readonly request: UserInputRequest }
  | { readonly type: 'user-input-response'; readonly requestId: string; readonly response: UserInputDecision }
  | { readonly type: 'usage'; readonly usage: RuntimeRunReport['usage']; readonly report: RuntimeRunReport }
  | { readonly type: 'error'; readonly error: RuntimeRunReport['errors'][number]; readonly report: RuntimeRunReport }
)

export interface RuntimeAgentResponse {
  readonly runId: string
  readonly traceId: string
  readonly text: string
  readonly usage: RuntimeRunReport['usage']
  readonly report: RuntimeRunReport
}

export interface RuntimeAgentRunHandle extends AsyncIterable<RuntimeAgentRunEvent> {
  readonly runId: string
  readonly result: Promise<RuntimeAgentResponse>
  readonly report: Promise<RuntimeRunReport>
  abort(reason?: unknown): void
}

export interface RuntimeAgentSessionSnapshot extends AgentSessionSnapshot {
  readonly memoryBindingId?: string
}

export interface RuntimeAgentSession {
  readonly conversationId: string
  readonly isRunning: boolean
  run(input: string, options?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse>
  stream(input: string, options?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle
  inject(input: string): number
  snapshot(): RuntimeAgentSessionSnapshot
  compact(options?: RuntimeAgentInvocationOptions): Promise<CompactionResult | null>
  reset(): void
  whenIdle(signal?: AbortSignal): Promise<void>
}

export interface RuntimeAgent {
  readonly model: ModelTarget
  generate(input: string, options?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse>
  stream(input: string, options?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle
  createSession(options?: RuntimeAgentSessionOptions): RuntimeAgentSession
  resumeSession(snapshot: RuntimeAgentSessionSnapshot, options?: RuntimeAgentSessionOptions): RuntimeAgentSession
}

export type LegacyAgentEvent = AgentRunEvent
