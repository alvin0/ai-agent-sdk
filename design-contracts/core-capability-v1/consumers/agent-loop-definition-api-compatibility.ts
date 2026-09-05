import {
  AGENT_CONTROL_TOOLS,
  cloneAgent,
  createUserInputBroker,
  defineAgent,
  runAgent,
  runToolCalls,
  runTurn,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentDefinitionOverrides,
  type AgentEvent,
  type AgentInput,
  type AgentInvocationOptions,
  type AgentMode,
  type AgentResponse,
  type AgentResumeSessionOptions,
  type AgentRunEvent,
  type AgentRunHandle,
  type AgentRunOutcome,
  type AgentRuntimeLimits,
  type AgentSession,
  type AgentSessionOptions,
  type AgentSessionSnapshot,
  type AssistantContentTiming,
  type BasicAgentOptions,
  type CloneAgentOverrides,
  type CompletionSubmission,
  type DeepAgentOptions,
  type DefinedAgent,
  type ExhaustedBudget,
  type HumanInLoopAgentOptions,
  type InteractiveUserInputBroker,
  type InteractiveUserInputBrokerOptions,
  type RunAgentOptions,
  type RunToolCallsOptions,
  type RunTurnOptions,
  type StreamedAssistantTextPhase,
  type ToolCallsOutcome,
  type TurnBounds,
  type TurnEndReason,
  type TurnOutcome,
  type UserInputBroker,
} from '@ai-agent-sdk/core/agent'

type Equivalent<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left] ? true : false
    : false
type Assert<Value extends true> = Value

export type AgentLoopDefinitionApiShape = [
  Assert<Equivalent<AgentMode, 'basic' | 'deep' | 'deep-human-in-loop'>>,
  Assert<Equivalent<AssistantContentTiming,
    'standalone' | 'before-tools' | 'after-tools' | 'between-tools'>>,
  Assert<Equivalent<ExhaustedBudget,
    | 'steps'
    | 'tool-calls'
    | 'consecutive-tool-errors'
    | 'repeated-tool-call'
    | 'tool-call-cycle'
    | 'tokens'>>,
  Assert<Equivalent<AgentInput, string | import('@ai-agent-sdk/core').UserMessage>>,
  Assert<Equivalent<AgentSessionSnapshot['version'], 1>>,
]

export type AgentLoopDefinitionTypeInventory = [
  AgentDefinition,
  AgentDefinitionInput,
  AgentDefinitionOverrides,
  AgentEvent,
  AgentInvocationOptions,
  AgentResponse,
  AgentResumeSessionOptions,
  AgentRunEvent,
  AgentRunHandle,
  AgentRunOutcome,
  AgentRuntimeLimits,
  AgentSessionOptions,
  BasicAgentOptions,
  CloneAgentOverrides,
  CompletionSubmission,
  DeepAgentOptions,
  DefinedAgent,
  HumanInLoopAgentOptions,
  InteractiveUserInputBroker,
  InteractiveUserInputBrokerOptions,
  RunAgentOptions,
  RunToolCallsOptions,
  RunTurnOptions,
  StreamedAssistantTextPhase,
  ToolCallsOutcome,
  TurnBounds,
  TurnEndReason,
  TurnOutcome,
  UserInputBroker,
]

const defined = defineAgent({
  id: 'compatibility-agent',
  provider: 'compatibility-provider',
  model: 'compatibility-model',
  instructions: 'Return a compact answer.',
})
const cloned = cloneAgent(defined, { id: 'compatibility-agent-clone' })
const broker = createUserInputBroker({ maxPending: 8 })

/** Representative legacy definition/session source compiled unchanged on both modules. */
export function exerciseAgentDefinitionApi(
  session: AgentSession,
  invocation: AgentInvocationOptions,
): readonly [DefinedAgent, DefinedAgent, InteractiveUserInputBroker] {
  void defined.with({ commentary: 'concise' })
  void session.conversationId
  void session.history
  void session.memory
  void session.skills
  void session.isRunning
  void session.snapshot()
  void session.compact(invocation)
  void session.inject('additional context')
  void session.whenIdle(invocation.signal)
  void session.stream('request', invocation)
  void session.streamPending(invocation)
  void session.run('request', invocation)
  void session.runPending(invocation)
  void AGENT_CONTROL_TOOLS.complete
  return [defined, cloned, broker]
}

export function exerciseAgentLoopApi(
  agentOptions: RunAgentOptions,
  turnOptions: RunTurnOptions,
  toolOptions: RunToolCallsOptions,
): readonly [AsyncIterable<AgentRunEvent>, AsyncIterable<AgentEvent>, Promise<ToolCallsOutcome>] {
  return [runAgent(agentOptions), runTurn(turnOptions), runToolCalls(toolOptions)]
}
