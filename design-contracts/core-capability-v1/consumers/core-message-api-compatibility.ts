import {
  MessageId,
  ProviderRequestId,
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createMessage,
  createTextMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
  normalizeModelFailure,
  type A2AMessageSource,
  type AgentMessageSource,
  type AssistantMessage,
  type AssistantProvenance,
  type AssistantTextPhase,
  type Branded,
  type ContentBlock,
  type ContentBlockMap,
  type ContentBlockType,
  type FinishReason,
  type FinishReasonMap,
  type ImageBlock,
  type ImageDetail,
  type ImageMediaType,
  type ImageSource,
  type Message,
  type MessageSource,
  type MessageSourceMap,
  type ModelFailure,
  type ModelMessageSource,
  type NativeToolCallBlock,
  type ReasoningBlock,
  type ReplayEnvelope,
  type TextAnnotation,
  type TextAnnotationMap,
  type TextBlock,
  type TokenUsage,
  type ToolCallBlock,
  type ToolMessageSource,
  type ToolResultBlock,
  type ToolResultMessage,
  type ToolResultMessageInput,
  type UrlCitationAnnotation,
  type UserMessage,
} from '@ai-agent-sdk/core'

type Equivalent<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left] ? true : false
    : false
type Assert<Value extends true> = Value

/** Compile this same source once against current core and once against target core. */
export type CoreMessageApiShape = [
  Assert<Equivalent<AssistantTextPhase, 'commentary' | 'final-answer'>>,
  Assert<Equivalent<ImageMediaType, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'>>,
  Assert<Equivalent<ImageDetail, 'auto' | 'low' | 'high' | 'original'>>,
  Assert<Equivalent<ContentBlockType, keyof ContentBlockMap>>,
  Assert<Equivalent<ContentBlock, ContentBlockMap[keyof ContentBlockMap]>>,
  Assert<Equivalent<FinishReason, FinishReasonMap[keyof FinishReasonMap]>>,
  Assert<Equivalent<MessageSource, MessageSourceMap[keyof MessageSourceMap]>>,
  Assert<Equivalent<MessageId, Branded<'MessageId'>>>,
  Assert<Equivalent<ToolCallId, Branded<'ToolCallId'>>>,
  Assert<Equivalent<ProviderRequestId, Branded<'ProviderRequestId'>>>,
  Assert<Equivalent<ReasoningEffortId, Branded<'ReasoningEffortId'>>>,
]

export type CoreMessageApiInventory = [
  TextBlock,
  UrlCitationAnnotation,
  TextAnnotationMap,
  TextAnnotation,
  ReasoningBlock,
  ImageSource,
  ImageBlock,
  NativeToolCallBlock,
  ToolCallBlock,
  ToolResultBlock,
  TokenUsage,
  ReplayEnvelope,
  ModelFailure,
  AssistantProvenance,
  ModelMessageSource,
  ToolMessageSource,
  AgentMessageSource,
  A2AMessageSource,
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  ToolResultMessageInput,
]

export function exerciseCoreMessageApi(): {
  readonly message: Message
  readonly user: UserMessage
  readonly assistant: AssistantMessage
  readonly toolResult: ToolResultMessage
  readonly failure: ModelFailure
} {
  const callId = ToolCallId('call-1')
  const content: readonly ContentBlock[] = [{ type: 'text', text: 'hello' }]
  const message = freezeMessage(createMessage({
    role: 'system',
    content,
    source: { kind: 'app', producer: 'compatibility-fixture' },
  }))
  const user = createUserMessage({ content, source: { kind: 'user' } })
  const assistant = createAssistantMessage({
    content,
    source: { provider: 'fixture', model: 'fixture-model' },
  })
  const toolResult = createToolResultMessage({ callId, content, isError: false })
  const text = createTextMessage('hello')
  const messageId: MessageId = MessageId(text.id)
  const providerRequestId: ProviderRequestId = ProviderRequestId('request-1')
  const effort: ReasoningEffortId = ReasoningEffortId('low')
  const failure = normalizeModelFailure({
    message: `${messageId}:${effort}`,
    code: 'FIXTURE',
    requestId: providerRequestId,
  })
  return { message, user, assistant, toolResult, failure }
}
