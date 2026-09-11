# Messages, content blocks, images, documents

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
PDFs, or set an explicit source.

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
  'document': DocumentBlock
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

### `document`

PDF input. Providers read a PDF with **vision**, not plain text extraction: each
page is rasterized alongside its extracted text, so charts and tables survive.
That is why this is its own block rather than sugar over `ImageBlock` — the
provider owns the page splitting.

```ts
type DocumentMediaType = 'application/pdf'

type DocumentSource =
  | { kind: 'base64'; mediaType: DocumentMediaType; data: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; fileId: string }

interface DocumentBlock {
  type: 'document'
  source: DocumentSource
  filename?: string   // Responses infers the file type from it; a default is substituted
  title?: string      // Anthropic attributes citations to it; falls back to filename
  context?: string    // extra context, passed through where supported
  citations?: boolean // native citations, ignored by providers that have none
  pages?: number      // LOCAL only — never serialized; see token estimation below
}
```

PDF only, deliberately: all three provider families document PDF as a native
vision-backed input, while the other file types each accepts differ per provider.
A caller with a DOCX extracts text and sends text.

```ts
import { createUserMessage } from '@alvin0/ai-agent-sdk-core'

await agent.generate(createUserMessage({
  content: [
    { type: 'document',
      source: { kind: 'base64', mediaType: 'application/pdf', data: base64Pdf },
      filename: 'inquiry.pdf', pages: 72 },
    { type: 'text', text: 'Summarize the open items.' },
  ],
  source: { kind: 'app', producer: 'support-ui' },
}))
```

All three source kinds work on all three protocols — unlike images, where
Anthropic rejects `{ kind: 'file' }`. Anthropic's Files API id is in fact the
recommended path for a PDF large enough to strain its 32 MB request cap.

**A model must declare the `document` modality or the PDF is silently projected
to text.** An omitted modality is a negative capability claim, and this bites
hardest on Codex, whose discovery reports only `text` and `image` even for models
that do accept PDFs:

```ts
codexNodeAdapter({
  authStore,
  models: [{ id: 'gpt-5.6-luna', inputModalities: ['text', 'image', 'document'] }],
})
```

Gemini ships no built-in catalog, so declare it there too. `documentPolicy:
'strict'` on an invocation fails loudly instead of degrading the PDF — use it
whenever the answer depends on the file actually arriving.

#### Token estimation and `pages`

Providers bill a PDF **per page**, so `pages` is what lets compaction cost it
correctly. Measured against a real 72-page PDF: OpenAI billed 214,019 input
tokens (~2,970/page) and Gemini 38,350 (~533/page). With `pages` set, the
estimator came within 1%; without it, it assumes 8 pages and under-states that
document by ~9x. Set it whenever you can — it is local metadata and no adapter
sends it.

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
contentHasImage(content)               // does this content carry an image block
contentHasDocument(content)            // does this content carry a document block
projectImagesForTextModel(messages)    // the lossy text-only projection
projectDocumentsForTextModel(messages) // same, for documents
textOnlyImageText                      // the placeholder that projection substitutes
textOnlyDocumentText                   // same, for documents; prefers the filename
freezeMessage(message)                 // deep-freeze one message
```

Both `contentHas*` helpers recurse into `tool-result` and `native-tool-call`, so a
tool that returns a screenshot or a generated PDF is not missed by a shallow scan.
