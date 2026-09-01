/**
 * The provider-neutral core. Adapters are the only layer that knows a provider's
 * wire format; everything else in this package speaks what is exported here.
 *
 * Read the folders in dependency order to understand the design:
 *
 * - `primitives/` — branded ids, deep freeze, exhaustiveness. No dependencies.
 * - `errors/`     — the `code`-routed taxonomy and its serializable twin.
 * - `message/`    — content blocks, immutable messages, content projection.
 * - `stream/`     — the chunk protocol, its assembler, SSE and idle bounds.
 * - `contract/`   — what an adapter implements and what it receives.
 * - `runtime/`    — the registry that routes calls, and retry.
 * - `http/`       — credential and attribution concerns adapters share.
 *
 * @module ai-agent-sdk/core
 */

export * from './primitives/index.ts'
export * from './errors/index.ts'
export * from './message/index.ts'
export * from './stream/index.ts'
export * from './contract/index.ts'
export * from './runtime/index.ts'
export * from './http/index.ts'
