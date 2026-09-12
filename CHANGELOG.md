# Changelog

All notable changes to the AI Agent SDK are documented in this file.

## 0.1.1 - 2026-09-13

### Added

- Added document input support across the core message contract and the Anthropic Messages, Gemini Interactions, OpenAI Responses, OpenAI Chat Completions, and Codex provider paths, with strict validation and projection rules.
- Added the public embedding API and composition runtime, including model catalogs, request validation, batching, limits, retries, caching, usage accounting, lifecycle observations, and provider conformance tests.
- Added OpenAI and Gemini embedding adapters, including configurable model capabilities and compatibility identities.
- Added `@alvin0/ai-agent-sdk-provider-copilot` with GitHub device-flow authentication, token persistence, model discovery, generation, embeddings, and Node CLI support.
- Added `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` with serialization and streaming translation for text, tools, terminal states, truncation, and usage.
- Added per-invocation model overrides for agent runs.

### Changed

- Reworked `@alvin0/ai-agent-sdk-provider-http` around shared connection, session, JSON, and streaming transport primitives with bounded redirects, timeouts, abort handling, media-type validation, and credential-safe observations.
- Extended provider and testkit contracts to cover embedding and Copilot conformance, generation-oracle fixtures, and SSE/JSON transport equivalence.
- Improved provider documentation and model limit guidance in English and Vietnamese.

### Release scope

- All workspace SDK packages move from `0.1.0` to `0.1.1` so the lockstep release workflow can publish a complete, internally compatible package set.
- `@alvin0/ai-agent-sdk-provider-copilot` and `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` are published for the first time at `0.1.1`.
- `@alvin0/ai-agent-sdk-testkit` remains private but carries the same workspace version.

## 0.1.0 - 2026-09-09

- Initial public release of the capability-based AI Agent SDK packages.
