# Structured output

`outputFormat` constrains the model's visible text. Provider-neutral — the same
declaration works on OpenAI Responses, Anthropic Messages, and Gemini
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

const invoice = JSON.parse((await agent.generate(document)).text)
```

The text is guaranteed to be JSON, or the run failed.

## The contract

```ts
type ModelOutputFormat = TextOutputFormat | JsonSchemaOutputFormat

interface TextOutputFormat { readonly type: 'text' }

interface JsonSchemaOutputFormat {
  readonly type: 'json_schema'
  readonly name: string                    // stable identifier, required by OpenAI Responses
  readonly schema: Readonly<JsonObject>    // provider-supported JSON Schema
}
```

Accepted on `runtime.agent()`, `defineAgent()`, `runAgent()`, and as
`outputFormat` on `GenerateOptions` for `ModelRegistry.stream()`. Omitting it
means ordinary unconstrained text.

## Validation happens at definition time

The schema is validated, detached, bounded, and frozen when the agent is
defined — not on the first request. Mutating your object afterwards cannot
change what the agent sends.

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

Only `type`, `name`, and `schema` are accepted; an extra key is rejected rather
than ignored. An invalid shape throws immediately:

```
TypeError: agent outputFormat must be text or a bounded JSON Schema with a valid name
```

Provider-specific JSON Schema subsets still apply — a keyword your endpoint
rejects will still be rejected at the wire boundary.
