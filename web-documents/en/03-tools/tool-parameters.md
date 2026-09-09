# Tool Parameters

## The schema the model sees

`parameters` is plain JSON Schema. It is sent to the provider verbatim and is
the only description the model gets of your argument shape.

```ts
parameters: {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Full-text search query.' },
    limit: { type: 'number', description: 'Max rows. Defaults to 20.' },
    mode: { type: 'string', enum: ['read', 'write'] },
  },
  required: ['query'],
}
```

Practical rules:

- **Describe every property.** A bare `{ type: 'string' }` tells the model
  nothing about units, format, or scope.
- **Use `enum` for closed sets.** It removes a whole class of invalid call.
- **Mark `required` honestly.** Optional-with-default is clearer than
  required-then-ignored.
- **Keep it shallow.** Deeply nested objects invite malformed calls; prefer
  several flat tools over one polymorphic tool.
- **Schemas cost context.** Tool schemas are measured as part of every request.
  A large catalog is a real input cost.

## `parse` is the trust boundary

```ts
parse?: (raw: unknown) => Args
```

`parse` validates and narrows raw arguments **before `execute` sees them**. The
hook exists so the SDK needs no schema library of its own — plug in whatever you
already use.

```ts
import { z } from 'zod'
const Args = z.object({ query: z.string().min(1), limit: z.number().int().positive().max(100) })

parse: raw => Args.parse(raw),
```

```ts
import * as v from 'valibot'
const Args = v.object({ query: v.pipe(v.string(), v.minLength(1)) })

parse: raw => v.parse(Args, raw),
```

```ts
// Hand-written, no dependency
parse: raw => {
  const o = raw as Record<string, unknown>
  if (typeof o.query !== 'string' || o.query.length === 0) throw new TypeError('query required')
  return { query: o.query, limit: typeof o.limit === 'number' ? o.limit : 20 }
},
```

## Throwing in `parse` is a feature

A throw produces an **`INVALID_ARGUMENTS` tool result** that the model sees and
can correct on the next step. It is not a crash, and it does not end the turn.

That is why `parse` beats validating inside `execute`: the failure is shaped as
model-correctable feedback rather than an application error.

Make the message actionable — the model reads it:

```ts
parse: raw => {
  const parsed = Args.safeParse(raw)
  if (!parsed.success) {
    throw new TypeError(`limit must be 1–100; got ${(raw as any)?.limit}`)
  }
  return parsed.data
},
```

## Omitting `parse`

```ts
// execute receives the parsed JSON UNVALIDATED, typed as Args on trust.
execute: (args: { a: number; b: number }) => ({ product: args.a * args.b })
```

Acceptable only when the body checks its own inputs, or when a wrong type is
harmless. Anything that reaches a filesystem, a database, a shell, or a network
call should validate.

## Schema and validation must agree

The JSON Schema shapes what the model *tries* to send; `parse` decides what is
*accepted*. Drift between them shows up as avoidable `INVALID_ARGUMENTS` loops.

```ts
// Schema says limit is optional; parse requires it → the model gets rejected
// for a call the schema told it was legal.
parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
parse: raw => z.object({ limit: z.number() }).parse(raw),   // ✗ mismatch
```

If you generate JSON Schema from your validator, this class of bug disappears.

## Repeated invalid calls are bounded

Exact-repeat detection warns at `repeatToolWarningAt` and stops at
`repeatToolLimit`; consecutive failures are cut off by
`maxConsecutiveToolErrors`. So a model that cannot satisfy your schema fails
loudly instead of looping until the token ceiling.

If you see that happen, the schema or the description is usually the defect.

## Read next

- [Error Handling](/en/03-tools/error-handling) — the full result shape
- [Structured Output](/en/02-agents/structured-output) — `parse` as an output contract
