# Messages, content blocks, images

## One message model everywhere

```ts
interface Message {
  readonly id: MessageId                              // stable across every boundary
  readonly role: 'system' | 'user' | 'assistant'       // provider-neutral
  readonly content: readonly ContentBlock[]            // the exact model-facing blocks
  readonly source: MessageSource                       // who produced it
}

interface UserMessage extends Message { readonly role: 'user' }
interface AssistantMessage extends Message { readonly role: 'assistant'; readonly source: ModelMessageSource }

/** A tool result is a user-role message carrying exactly one tool-result block. */
interface ToolResultMessage extends Message {
  readonly role: 'user'
  readonly content: readonly [ToolResultBlock]
  readonly source: ToolMessageSource
}
```

`source` is the authority record: `app`, `model`, `tool`, `agent-message`
(in-process A2A control plane), `a2a-message` (an A2A server transport). It is
why task memory can stay user-authored without being promoted to a system rule.

Anywhere an agent takes input, the type is:

```ts
type AgentInput = string | UserMessage
```

So a plain string is fine, and a full `UserMessage` is how you attach images or
set an explicit source.

## Constructors

```ts
createTextMessage(text: string): UserMessage        // "the user typed something"
createUserMessage(input): UserMessage               // content + optional source
createAssistantMessage(input): AssistantMessage     // content + provider/model + replay state
createToolResultMessage({ callId, content, isError }): ToolResultMessage
```

`id` and `role` are assigned for you — passing either is a type error, which is
what keeps identity and role tags trustworthy.

## Content blocks

```ts
interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'native-tool-call': NativeToolCallBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}

type ContentBlock = ContentBlockMap[keyof ContentBlockMap]
```

Switch on `type` and **fall through unknowns** — the map is merge-extensible.

### `text`

```ts
interface TextBlock {
  type: 'text'
  text: string
  phase?: 'commentary' | 'final-answer'     // narration vs the terminal answer
  annotations?: readonly TextAnnotation[]   // e.g. url-citation
}
```

The `phase` tag is what makes commentary classified rather than guessed, and it
is the same distinction the run events carry.

### `reasoning`

```ts
interface ReasoningBlock { type: 'reasoning'; text: string; providerState?: unknown }
```

Kept distinct from visible text and **never** mixed into it. `providerState`
exists for a concrete reason: Anthropic requires a thinking block to be echoed
back byte-identically with its signature on the next request of a tool-use loop.
Dropping it degrades quality and can be rejected outright. Treat the value as
opaque and preserve it.

### `image`

```ts
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

type ImageSource =
  | { kind: 'base64'; mediaType: ImageMediaType; data: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; fileId: string }

interface ImageBlock { type: 'image'; source: ImageSource; detail?: 'auto' | 'low' | 'high' | 'original' }
```

Sources are inline rather than handles into an attachment store, because an SDK
cannot assume its host has one. A host with durable storage resolves its own
reference into one of these before building the request.

```ts
import { createUserMessage } from '@alvin0/ai-agent-sdk-core'

await agent.generate(createUserMessage({
  content: [
    { type: 'text', text: 'What is wrong in this screenshot?' },
    { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: base64Png } },
  ],
  source: { kind: 'app', producer: 'support-ui' },
}))
```

The registry projects image input away **only** for models that explicitly
declare no vision support; `imagePolicy: 'strict'` on an invocation rejects
known text-only models instead of silently converting, and `'project'` permits
the lossy conversion. Content a model cannot accept otherwise fails with
`UNSUPPORTED_CONTENT`.

### `tool-call` and `tool-result`

```ts
interface ToolCallBlock {
  type: 'tool-call'
  id: ToolCallId
  name: string
  arguments: string      // the RAW JSON string the model produced
}

interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: ToolCallId
  content: ContentBlock[]
  isError?: boolean
}
```

`arguments` is deliberately **not parsed** at the transport boundary. Models emit
invalid JSON often enough that parsing there would turn a recoverable "tell the
model it sent bad arguments" into an unrecoverable stream failure. The tool
layer parses and reports the error back into the conversation.

### `native-tool-call`

```ts
interface NativeToolCallBlock {
  type: 'native-tool-call'
  id: string                     // provider item id, for replay and GUI correlation
  name: string                   // 'web-search' | 'image-generation' | an extension
  status?: string
  arguments?: JsonValue
  content: ContentBlock[]        // public result content, generated images included
  providerState?: unknown        // adapter-private, needed for stateless replay
}
```

## Assembling a stream into blocks

`BlockAssembler` turns the neutral `StreamChunk` protocol into blocks; it is
what `generate()` uses under the hood. Reach for it with
`ModelRegistry.stream()` when you want the raw protocol and no agent loop.

## Helpers worth knowing

```ts
contentHasImage(content)            // does this content carry an image block
projectImagesForTextModel(content)  // the lossy text-only projection
textOnlyImageText                   // the placeholder that projection substitutes
freezeMessage(message)              // deep-freeze one message
```
