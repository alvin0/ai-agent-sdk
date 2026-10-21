# Upgrading to 0.1.14

Upgrade the SDK packages together to **0.1.14**. The workspace has 28 package
manifests, of which 27 are publishable; `testkit` remains private. A push to
`main` triggers guarded publication, while manual Release dispatch defaults to
a dry run. Local checks do not prove npm publication or hosted CI success.

The [0.1.14 changelog](../CHANGELOG.md#0114---2026-10-21) is authoritative. This
guide covers what a host must check. The new options are described in
[image retention, tool errors, skill diagnostics and usage totals](image-retention-and-diagnostics.md).

## Tool error text now includes the code

A failed tool call used to reach the model as `Error: message`. It is now
rendered as `[CODE] message`, for example `[TOOL_TIMEOUT] the tool exceeded its
time limit`. This covers thrown tool errors, invalid arguments, interceptor
denials, denied approvals and timeouts.

```ts
// Keep the 0.1.13 text.
const session = agent.createSession({ registry, toolErrorRendering: false })

// Or render your own text. Only `code` and `message` are passed.
const custom = agent.createSession({
  registry,
  toolErrorRendering: ({ code }) => `The tool failed (${code}). Try a different approach.`,
})
```

If a renderer throws, returns a non-string or returns blank text, the default
`[CODE] message` form is used. Content an interceptor wrote for the model is
passed through unchanged. Update tests or prompts that match the literal
`Error: ` prefix.

## Skill discovery skips invalid candidates

In 0.1.13 one invalid provider candidate failed the whole skill discovery. Now
the candidate is skipped, the rest of the catalog stays available, and a
bounded diagnostic is emitted.

```ts
const session = agent.createSession({
  registry,
  onSkillDiagnostic: diagnostic => logger.warn('skill candidate rejected', diagnostic),
  // strictSkillCandidates: true, // restore 0.1.13 all-or-nothing discovery and errors
})
```

Each diagnostic has `type: 'skill-candidate-rejected'`, `code:
'SKILL_CANDIDATE_REJECTED'`, a `providerId`, an optional `candidateId` (at most
128 characters) and a typed `reason` such as `name-invalid`,
`provider-mismatch`, `duplicate-id`, `candidate-limit` or `catalog-byte-limit`.
`validateCandidate()` throws `SkillCandidateValidationError` with the same
`reason`. Providers can check metadata against the exported
`SKILL_CANDIDATE_LIMITS` before returning it.

## New: image retention

`imageRetention` bounds how many image blocks each model request carries. It is
off unless you set it.

```ts
const session = agent.createSession({
  registry,
  imageRetention: { keepLatest: 2, persist: 'drop-pruned' },
})
console.log(session.imageRetentionStats())
```

Older images become a stable text placeholder at their original position, so
tool-call pairing stays valid on every provider. With `persist: 'keep'` (the
default) snapshots keep the original bytes. With `'drop-pruned'` the bytes are
also removed from history and snapshots. The policy is session configuration:
pass it again to `resumeSession(snapshot, options)`.

## New: completion gate and continuation

`hooks.beforeCompletion` runs when the model stops on its own while capacity
remains, before empty-answer recovery. It and `onTurnEnd` may now return
`{ kind: 'continue', messages }` to keep working in the same turn and run.

```ts
import { createUserMessage } from '@alvin0/ai-agent-sdk-core'

const session = agent.createSession({
  registry,
  hooks: {
    beforeCompletion: ({ canContinue }) => {
      if (!canContinue || reviewDone()) return
      return { kind: 'continue', messages: [createUserMessage({
        source: { kind: 'app', producer: 'review-gate' },
        content: [{ type: 'text', text: 'The review is not done yet. Continue.' }],
      })] }
    },
  },
})
```

Every message must be a user message with `source.kind: 'app'`; otherwise the
whole batch is rejected and nothing is appended. An empty batch does not
continue the turn. Continuation is ignored once a turn is exhausted, failed or
cancelled. Bound repeated objections in your own gate.

## New: usage totals

`getUsageTotals(response.usage)` from `@alvin0/ai-agent-sdk-core/agent` returns
`inputTokens`, `outputTokens`, `cachedInputTokens` and `reasoningTokens`.
Counters a provider did not report are `undefined`, not zero. The full
`RunUsageReport` is unchanged.

## Other changes

- Bun native transport errors such as `ECONNRESET` or `ETIMEDOUT` are now
  treated as network failures instead of malformed model errors.
- `@modelcontextprotocol/server` and `@modelcontextprotocol/client` are 2.3.1.
  This fixes high-severity advisories in the MCP server SDK.

## Checklist

1. Upgrade every `@alvin0/ai-agent-sdk-*` package to 0.1.14 together.
2. Update tests or prompts that match the `Error: ` tool failure prefix, or set
   `toolErrorRendering: false`.
3. Decide whether skill discovery should stay lenient. Add `onSkillDiagnostic`
   logging, or set `strictSkillCandidates: true`.
4. Optional: set `imageRetention` for image-heavy sessions, and pass it again on
   resume.
5. Run your test suite.
