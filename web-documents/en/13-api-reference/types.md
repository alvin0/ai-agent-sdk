# Types

## Content blocks

A message's `content` is an array of typed blocks. Seven block types exist:

| Block | Purpose |
| --- | --- |
| `TextBlock` | Visible text. Assistant text also carries an `AssistantTextPhase`. |
| `ReasoningBlock` | Reasoning summary or content the provider actually emitted. |
| `ImageBlock` | Image input or generated output. |
| `DocumentBlock` | PDF input, read by the provider with native vision. |
| `ToolCallBlock` | A host tool the scheduler must execute. |
| `ToolResultBlock` | The result of a host tool call, correlated by call id. |
| `NativeToolCallBlock` | A provider-executed tool. The scheduler never runs it. |

### Image sources

```ts
{ kind: 'base64', mediaType: ImageMediaType, data: string }   // portable
{ kind: 'url', url: string }                                   // portable
{ kind: 'file', fileId: string }                               // Responses only
```

`base64` and `url` are portable across providers. `{ kind: 'file', fileId }` and
`detail: 'original'` are accepted by the Responses API only; Anthropic reports
them as a typed `INVALID_REQUEST` error rather than silently dropping them.

### Document sources

```ts
interface DocumentBlock {
  type: 'document'
  source:
    | { kind: 'base64'; mediaType: 'application/pdf'; data: string }
    | { kind: 'url'; url: string }
    | { kind: 'file'; fileId: string }
  filename?: string   // Responses infers the file type from it
  title?: string      // Anthropic attributes citations to it
  context?: string
  citations?: boolean
  pages?: number      // local metadata for token estimation; never serialized
}
```

All three source kinds are portable here — unlike images, Anthropic accepts a
Files API `fileId` for documents, and it is the recommended path for a PDF large
enough to strain its 32 MB request cap.

The media type is PDF only, deliberately. All three provider families document
PDF as a native vision-backed input; the other file types each provider accepts
differ per provider, so admitting them would let a request typecheck against a
provider that rejects it. A caller with a DOCX extracts text and sends text.

See [Document input](/en/03-tools/native-tools#document-pdf-input) for the
capability declaration a model needs before a PDF will reach it.

## Messages are immutable

```ts
import { createTextMessage } from '@alvin0/ai-agent-sdk-core'

const message = createTextMessage('What is 21 * 2?')
```

Every message carries a `source` that records where it came from:

| Source kind | Meaning |
| --- | --- |
| `user` | A real end-user turn. |
| `model` | An assistant message, with provider/model provenance. |
| `tool` | A tool result, correlated by `callId`. |
| `app` | Host-authored context, tagged with a `producer`. |
| `agent-message` | Another local agent in an `AgentTeam`. |
| `a2a-message` | A remote A2A peer, with protocol `contextId` / `messageId` / `taskId`. |

Source matters for authority. Task memory is injected as **app-authored user
context**, not as system instructions, so a user-authored objective retains user
authority instead of being promoted to developer authority.

## Assistant text phases

Assistant text is classified, not guessed:

| Phase | Meaning |
| --- | --- |
| `commentary` | Short user-visible progress narration around tool use. |
| `final-answer` | The answer itself. |

This is deliberately separate from reasoning. `assistant-reasoning` contains only
reasoning summary or content the provider actually emitted; `assistant-text` is
public text. Commentary events additionally carry `timing` — one of
`before-tools`, `after-tools`, `between-tools`, `standalone` — and tool-call id
arrays, so GUI linking is direct rather than heuristic.

Control it with `commentary`:

```ts
runtime.agent({ /* … */, commentary: 'concise' })  // ask for short progress text
runtime.agent({ /* … */, commentary: 'auto' })     // leave narration to the model
runtime.agent({ /* … */, commentary: 'off' })      // final answer only
```

## Assembling a stream

`BlockAssembler` consumes the chunk protocol and produces a message plus usage
and finish state.

```ts
const assembler = new BlockAssembler()
for await (const chunk of registry.stream(call)) assembler.push(chunk)

const message = assembler.message({ kind: 'model', provider: 'openai', model: 'gpt-5.4' })
assembler.usage     // TokenUsage | undefined
assembler.finish    // FinishReason
```

## Replay state

The terminal `finish` chunk may carry a `ReplayEnvelope` — adapter-private,
lossless-JSON state needed to replay a successful response on the next request.
Anthropic uses it to preserve encrypted native web-search results and citations.

```ts
interface ReplayEnvelope {
  response: unknown           // response-level metadata (ids, native stop reason)
  blocks?: readonly unknown[] // one entry per emitted block, in stream order
}
```

Both halves stay opaque above the adapter; only the **split** is shared
vocabulary. That is what lets assembly keep stored metadata aligned with stored
content without understanding either half. When assembly drops a block it drops
the entry at the same position; an envelope whose length does not match the
emitted block count is discarded whole, because a misaligned mapping is worse
than none.

## Read next

- [Providers and the registry](/en/09-providers/)
- [Native tools and images](/en/03-tools/native-tools)
