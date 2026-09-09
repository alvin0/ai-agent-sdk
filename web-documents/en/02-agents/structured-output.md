# Structured Output

`outputFormat` constrains the model's visible text. It is provider-neutral: the
same declaration works on OpenAI Responses, Anthropic Messages, and Gemini
Interactions.

```ts
const agent = runtime.agent({
  id: 'extractor',
  model,
  instructions: 'Extract the invoice fields from the attached document.',
  outputFormat: {
    type: 'json_schema',
    name: 'invoice',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        total: { type: 'number' },
        currency: { type: 'string' },
      },
      required: ['id', 'total', 'currency'],
    },
  },
})

const response = await agent.generate(document)
const invoice = JSON.parse(response.text)   // guaranteed to be JSON, or the run failed
```

## The contract

```ts
type ModelOutputFormat = TextOutputFormat | JsonSchemaOutputFormat

interface TextOutputFormat {
  readonly type: 'text'
}

interface JsonSchemaOutputFormat {
  readonly type: 'json_schema'
  /** Stable schema identifier. Required by providers such as OpenAI Responses. */
  readonly name: string
  /** Provider-supported JSON Schema. Provider-specific subsets still apply. */
  readonly schema: Readonly<JsonObject>
}
```

`outputFormat` is accepted on:

| Level | Field |
| --- | --- |
| `runtime.agent({ … })` | `outputFormat` |
| `defineAgent({ … })` | `outputFormat` |
| `runAgent({ … })` | `outputFormat` |
| `ModelRegistry.stream(call)` | `outputFormat` on `GenerateOptions` |

Omitting it means ordinary unconstrained text.

## Validation happens at definition time

The schema is validated, **detached, bounded, and frozen** when the agent is
defined — not on the first request.

```ts
name: /^[A-Za-z0-9_-]{1,64}$/
```

| Bound | Limit |
| --- | --- |
| Schema bytes | 256 KiB |
| Schema depth | 32 |
| Schema nodes | 16,384 |
| Object fields | 512 |
| Array items | 1,024 |
| Key bytes | 256 |

An invalid shape throws immediately:

```
TypeError: agent outputFormat must be text or a bounded JSON Schema with a valid name
```

Only `type`, `name`, and `schema` are accepted — an extra key is rejected rather
than silently ignored. The schema is snapshotted, so mutating your object
afterwards cannot change what the agent sends.

## Tools and JSON schema together

This is the part worth understanding. When you combine a `json_schema` output
format **with callable tools**, the loop splits the turn into two phases:

```text
┌─ process phase ────────────────────────────────────────────┐
│  outputFormat forced to { type: 'text' }                   │
│  tools available, toolChoice honoured                      │
│  the model investigates, calls tools, reads results        │
└────────────────────────────────────────────────────────────┘
                            ↓
┌─ final output phase ───────────────────────────────────────┐
│  outputFormat = your json_schema                           │
│  toolChoice forced to 'none'                               │
│  the model emits the structured answer and nothing else    │
└────────────────────────────────────────────────────────────┘
```

Why: a model cannot both emit tool calls and satisfy a strict output schema in
the same response. Rather than making you choose, the SDK runs the tool loop
unconstrained and then adds a **dedicated final step** under the schema.

With **no** callable tools, there is no split — every step already runs under the
schema.

## Two failures you can rely on

**Invalid JSON in the final phase.**

```text
MALFORMED_RESPONSE: model returned invalid JSON for the requested structured output
```

The loop parses the final text. If the provider claimed `stop` but the text is
not JSON, the turn fails with a typed error rather than handing you a string that
`JSON.parse` will throw on later.

**A tool call during the final phase.**

```text
INVALID_TOOL_CALL: model emitted a host tool call during the final output phase
```

Tools are disabled in that phase, so a call there is a contract violation. The
offending block is stripped and the turn ends with the error.

Both mean the same thing for your code: if `generate()` resolved, the text
satisfies the shape you asked for.

## Provider support

| Provider | Mapping |
| --- | --- |
| OpenAI Responses | `text.format` — gated on the dialect's `structuredOutputs` |
| Anthropic Messages | `format: { type: 'json_schema', schema }` |
| Gemini Interactions | `response_format` |

All three are supported. Provider-specific JSON Schema subsets still apply — a
schema feature one provider accepts may be rejected by another as
`INVALID_REQUEST`.

## When a tool is the better answer

`outputFormat` constrains **the final text**. It does not help when you want the
model to *hand you a value mid-run*, or to submit several results, or to trigger
a side effect at the same time.

For that, use a tool that is the answer:

```ts
const submitReview = defineTool({
  name: 'submit_review',
  description: 'Submit the final review verdict. Call this exactly once, last.',
  parameters: { /* … */ },
  parse: raw => ReviewResult.parse(raw),
  execute: (args, ctx) => {
    sink.value = args
    ctx.concludeTurn()
    return { accepted: true }
  },
})
```

| Use `outputFormat` when | Use a submit tool when |
| --- | --- |
| The answer *is* the response text | You need the value in your code, typed, mid-run |
| One result per run | Several results, or a side effect on submit |
| You want provider-level constraint | You want `parse` to reject and let the model retry |

**`parse` gives you a retry path that `outputFormat` does not.** A throw inside
`parse` produces an `INVALID_ARGUMENTS` result the model reads and can correct on
the next step. A malformed structured output ends the turn.

The two compose: `mode: 'deep'` adds a structural completion self-check, so the
turn cannot end until the model's own `submit_result` check is accepted.

## Read next

- [Tool Parameters](/en/03-tools/tool-parameters) — `parse` as a trust boundary
- [Creating an Agent](/en/02-agents/creating-an-agent) — where `outputFormat` sits
- [Gemini](/en/09-providers/gemini) · [OpenAI](/en/09-providers/openai) · [Anthropic](/en/09-providers/anthropic)
