# Image retention, tool errors, skill diagnostics, and usage totals

These controls are provider-neutral and opt in at the session boundary. They do
not change an agent when omitted.

## Retain a bounded number of images

```ts
const session = agent.createSession({
  imageRetention: {
    keepLatest: 2,
    persist: 'drop-pruned',
  },
})

const response = await session.run({
  role: 'user',
  content: [
    { type: 'text', text: 'Compare this screen with the previous one.' },
    { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data } },
  ],
})

console.log(session.imageRetentionStats())
```

`keepLatest` counts `ImageBlock`s across the ordered model-facing history,
including user messages, tool results, and nested native-tool content. Older
blocks become text at their original location, preserving tool-result pairing
for Responses, Anthropic Messages, Gemini Interactions, and other adapters.
The default placeholder is stable across images. A custom `placeholder(info)`
may return a string or `{ type: 'text', text }`; it receives only source kind,
media type, detail, and serialized byte size, never image bytes. Its output is
bounded to 512 characters. The SDK caches the computed serialized size and
placeholder per immutable image block and policy, so the factory runs once for
that image and the replacement remains byte-identical across model rounds.

The policy runs after request hooks and before provider encoding on every model
round, including intermediate rounds in tool loops. The policy is session
configuration, so pass it again when calling `resumeSession(snapshot, options)`.
With `persist: 'keep'` (the default), snapshots retain original image
bytes while requests still contain at most `keepLatest` images. With
`persist: 'drop-pruned'`, old image data is replaced in in-memory history and
snapshots too, so later snapshots and resumed sessions do not restore those
bytes. History entry, total-byte, and individual-entry limits still apply.

`imageRetentionStats()` reports request and persistence counters, image count,
and serialized byte savings. Request pruning counts each prepared request
projection; persistence pruning counts each removed history image once. The
trace request summary includes per-round request pruning metrics. A missing
result means the session has no retention policy. The counters belong to the
live session and are not stored in snapshots: a resumed session starts from
zero and counts only pruning done from the resume onward.

The SDK resolves an options object once and reuses that result. If you change
the object afterwards, it is validated again the next time it is used, and the
new values replace the old ones.

Pruning preserves the prefix before the oldest image that ages out. The stable
placeholder avoids repeated content changes at already-pruned locations, but
the first pruning pass changes the suffix beginning at that location. Providers
may therefore reuse a smaller cacheable prefix than they did before the image
aged out. `drop-pruned` also makes that replacement permanent in later snapshots.

## Render stable tool error codes to the model

Session and run options accept `toolErrorRendering`. By default, a failure is
rendered as `[CODE] message`, including thrown tool failures, invalid arguments,
interceptor denials, denied approvals, and timeouts. The callback receives only
the stable code and model-facing error message; causes, stacks, and provider
response objects are not passed to it.

```ts
const session = agent.createSession({
  toolErrorRendering: ({ code }) => `The tool failed (${code}). Try a different approach.`,
})

// Set false to retain the former `Error: message` presentation.
const legacySession = agent.createSession({ toolErrorRendering: false })
```

Messages explicitly created with `ToolError.respondToModel()` and interceptor
reasons are intended for model feedback. Do not put credentials or raw provider
bodies in those messages. A custom renderer can replace the message entirely;
if it throws or returns a non-string or blank string, the default `[CODE] message` form is used.

Rendering only rewrites the default `Error: message` text. Content an
interceptor wrote for the model, such as `block` feedback or a `replace` result
with several or non-text blocks, reaches the model as written. Rendering runs
before the tool output budget, so `maxResultTokens` still bounds a long error
message.

## Keep a skill catalog available when one candidate is invalid

Skill candidates are validated independently by default. An invalid item is
skipped and the rest of the catalog remains available. Observe bounded,
provider-neutral diagnostics or restore strict all-or-nothing validation:

```ts
const session = agent.createSession({
  onSkillDiagnostic: diagnostic => logger.warn('skill candidate rejected', diagnostic),
  strictSkillCandidates: false, // default; true makes a rejected candidate fail discovery
})
```

Diagnostics include a typed reason and a candidate ID capped at 128 characters;
invalid or unreadable IDs are omitted. Observer exceptions are contained. The
public `SKILL_CANDIDATE_LIMITS` object and individual `MAX_SKILL_*` constants
are exported from `@alvin0/ai-agent-sdk-core/agent` so providers can check
metadata before returning it. `validateCandidate()` throws
`SkillCandidateValidationError` with a stable `.reason`; discovery uses that
same reason without parsing message text. Full instruction limits are checked
when a skill is loaded, not while listing lightweight metadata.

## Read normalized usage totals

`RuntimeAgentResponse.usage` remains the full `RunUsageReport`, including
reported/estimated provenance and coverage. Import `getUsageTotals` from the
agent entry point for a stable typed view. Unreported counters are `undefined`,
not zero; cached input maps from the canonical `cacheReadTokens` counter.

```ts
import { getUsageTotals } from '@alvin0/ai-agent-sdk-core/agent'

const totals = getUsageTotals(response.usage)
// { inputTokens, outputTokens, cachedInputTokens, reasoningTokens }
```

The existing `usage.reported`, `usage.estimated`, `coverage`, and
`authoritative` fields remain available for billing and audit decisions.
