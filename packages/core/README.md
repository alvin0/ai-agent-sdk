# `@alvin0/ai-agent-sdk-core`

Provider-neutral contracts and runtime primitives for building model adapters and streaming AI applications.

Runtime: **Universal**. Published code uses ECMAScript, Fetch-compatible types, Web Streams, AbortController, performance timing, and Web Crypto. It does not use Node built-ins, `process`, `Buffer`, local paths, filesystem access, child processes, or stdio.

```sh
pnpm add @alvin0/ai-agent-sdk-core
```

`createAgentRuntime()` is the recommended composition root. `defineAgent()`
captures a reusable agent definition, and every runtime exposes an `SdkLogger`
whose records share runtime/run correlation and privacy policy:

```ts
import {
  createAgentRuntime,
  defineAgent,
  type SdkLogger,
} from '@alvin0/ai-agent-sdk-core'

const runtime = await createAgentRuntime({ providers: [provider] })
const definition = defineAgent({ id: 'assistant', instructions: 'Be concise.' })
const logger: SdkLogger = runtime.logger({ fields: { component: 'assistant' } })
const agent = runtime.agent({ ...definition, model: { provider: 'openai', id: 'gpt-6-luna' } })
logger.info('agent ready')
```

```ts
import { ModelAdapter, ModelRegistry } from '@alvin0/ai-agent-sdk-core'

const registry = new ModelRegistry()
registry.registerAdapter(['example'], new YourAdapter())

const call = registry.stream({
  provider: 'example',
  model: 'model-id',
  messages: [],
})

for await (const chunk of call) {
  // Consume normalized chunks.
}

const report = await call.report
```

The package includes message and stream contracts, model registry and retry primitives, normalized errors, usage accounting, explicit observation/correlation ports, and transactional provider-plugin registration. Provider HTTP/SSE transport, concrete exporters, filesystem skills, environment credentials, and protocol implementations belong to separate capability packages.

The documented root plus `/agent`, `/memory`, `/observability`, `/provider`,
`/skills`, `/tools`, `/embedding`, and `./package.json` are public. Internal source paths are
not compatibility contracts.

Session `hooks.beforeCompletion` may return `{ kind: 'continue', messages: [...] }`
to finish pending application work after a model stops voluntarily. Use
`createUserMessage` with `source: { kind: 'app', producer: 'your-workflow' }`.
The SDK consumes this context inside the same turn and run, preserving usage,
remaining budgets, cancellation, and raw history. Continuation is ignored when
capacity is exhausted. This hook runs before empty-answer recovery, so it can
continue a model that stopped after commentary without a final answer.
Every message must be app-sourced; a mixed or
human-sourced batch is rejected atomically. An empty batch does not itself
continue the turn. Hosts should bound repeated completion objections and stop
when the workflow no longer makes progress. `{ kind: 'yield' }` still pauses
without a final completion or deep-mode polling.
`onTurnEnd` retains its recovered-outcome semantics and also accepts continuation
decisions; application completion gates should prefer `beforeCompletion`.

`validateJsonFileContent` from `/tools` or `/agent` validates complete `.json`
write/edit content before a host writes it. Validation defaults on, preserves accepted
bytes and reports recoverable syntax errors. See [workspace JSON writes](../../docs/workspace-json-writes.md)
for host opt-out and integration examples.

`createManagedAgentTeam` from `/agent` supports lead delegation and opt-in shared-board
collaboration. See the [multi-agent host guide](../../docs/multi-agent.md) for tools,
budgets and migration from 0.1.12, and the [offline example](../../samples/multi-agent-offline/README.md)
for both modes without provider credentials.

Opt-in optimization helpers added in 0.1.5 include `defineActionFusion` and
`createModelEvidenceReducer` from `/tools`, and `createContextOptimizer` from
`/memory`. Applications select pipeline steps, milestone summaries, log storage,
and reducer models. See the [application guide](https://github.com/alvin0/ai-agent-sdk/blob/main/docs/context-optimization.md)
for configuration, exact-evidence fallback, and runnable validation.

Existing agent, tool, and session imports remain available. Review the
[upgrade guide](https://github.com/alvin0/ai-agent-sdk/blob/main/docs/upgrading-from-0.1.4.md)
for narration defaults, queued steering receipts, and managed-team validation
changes after the published 0.1.4 release. Program tools additionally require
session-level `experimentalPrograms` grants; ordinary tools do not.

For 0.1.7 completion, pending input, stream replacement and Stop behavior, see
the [upgrade guide](https://github.com/alvin0/ai-agent-sdk/blob/main/docs/upgrading-from-0.1.6.md).
`RuntimeAgentSession.hasUnansweredInput()` and `runPending()` expose work left
after a terminal round. Use `response.completed` for objective completion.

In 0.1.8, the exact-repeat guard can reuse the immediately preceding successful
tool result and allow one bounded model replan. `EmbeddingError.failure` preserves
available provider HTTP status, retry delay and request id through normalization.
See [upgrading from 0.1.7](https://github.com/alvin0/ai-agent-sdk/blob/main/docs/upgrading-from-0.1.7.md)
for exclusions, cancellation and budget behavior.
