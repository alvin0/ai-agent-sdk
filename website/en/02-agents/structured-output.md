# Structured Output

Agents can request ordinary text or JSON constrained by a JSON Schema through
the provider-neutral `outputFormat` field.

## JSON Schema output

```ts
const reviewer = runtime.agent({
  id: 'reviewer',
  model: { provider: 'openai', id: 'gpt-5.6-sol' },
  instructions: 'Review the change and return the verdict.',
  outputFormat: {
    type: 'json_schema',
    name: 'review_result',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['ship', 'block'] },
        summary: { type: 'string' },
        blockers: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'summary', 'blockers'],
      additionalProperties: false,
    },
  },
})

const response = await reviewer.generate('Review the pending diff.')
const result = JSON.parse(response.text) as {
  verdict: 'ship' | 'block'
  summary: string
  blockers: string[]
}
```

The schema is validated as bounded lossless JSON, detached from the caller, and
frozen when the agent is defined. Provider-specific JSON Schema subsets still
apply; object schemas should normally declare all required properties and set
`additionalProperties: false`.

The SDK keeps `response.text` as the canonical response. It does not pretend
that a TypeScript cast validates untrusted data. Parse or validate it with zod,
valibot, ajv, or your own validator when it crosses your application's trust
boundary.

## Tool-loop behavior

`outputFormat` describes the visible final answer, not every internal model
step. When an agent can call tools and JSON Schema output is requested, the SDK
uses one stable shape through the loop:

1. Process rounds use `{ type: 'text' }` and may call tools normally.
2. A prose-only process result is retained as commentary, not accepted as the
   final answer.
3. The SDK makes one dedicated, tool-disabled final request with the requested
   JSON Schema. A budget-forced final request uses the schema directly too.

This keeps long tool loops independent from the final schema while ensuring
that `response.text` and the terminal outcome come from the schema-constrained
round. The dedicated finalization may consume one additional model request
beyond the normal process-step limit. The SDK also rejects a successful final
response that is not syntactically valid JSON; schema conformance itself is
enforced by the selected provider's structured-output implementation.

## Plain text

Text remains the default. It can also be selected explicitly:

```ts
const writer = runtime.agent({
  id: 'writer',
  instructions: 'Write a concise answer.',
  outputFormat: { type: 'text' },
})
```

## Provider mapping

| Provider protocol | Wire field | Support |
| --- | --- | --- |
| OpenAI Responses | `text.format` with `type: 'json_schema'` and `strict: true` | Supported |
| Anthropic Messages | `output_config.format` with `type: 'json_schema'` | Supported |
| Codex ChatGPT endpoint | `text.format` with `type: 'json_schema'` and `strict: true` | Supported |

The schema name may contain letters, numbers, `_`, and `-`, up to 64
characters. It is sent to providers that require a stable schema identifier and
ignored by protocols that do not use one.

## When a submission tool is still better

Use a final-answer tool instead when the provider does not support structured
outputs, or when validation failures must be returned to the model so it can
retry. A tool's `parse` hook remains the SDK's provider-independent validation
and recovery boundary.

## Read next

- [Creating an Agent](/en/02-agents/creating-an-agent)
- [Tool Parameters](/en/03-tools/tool-parameters)
- [Providers](/en/09-providers/)
