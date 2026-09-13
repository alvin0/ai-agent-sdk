# Changelog

All notable changes to the AI Agent SDK are documented in this file.

## 0.1.2 - 2026-09-13

### Added

- OpenAI, Anthropic, and Gemini generation adapters/plugins now accept custom endpoint `headers` as a record or synchronous resolver, and `allowInsecureHttp` for explicitly trusted local gateways.
- OpenAI and Gemini embedding adapters/plugins now accept custom headers. Prepared embedding calls retain one header snapshot across all batches.
- Added `getCodexTokens(store, options)` for store-backed token reads with optional automatic refresh, and `getCopilotToken(store, options)` for API-token acquisition with an application-owned cache and explicit invalidation. Both helpers are also re-exported by their Node auth entry points.
- Added a working SQLite credential-store example with tenant scoping, atomic revision checks, and tests for database persistence, refresh, and runtime integration.
- Added English and Vietnamese guidance for compatible gateways and database-owned credentials.

### Fixed

- Preserve the stored Codex account identity when a refresh response omits `id_token`.
- Reject malformed Codex refresh payloads and empty or non-string token fields before committing credentials.
- Honor cancellation while waiting for database reads or a custom Copilot token cache, including hooks that ignore their signal; observe late promise rejections after cancellation.
- Reject empty tenant scopes and unknown provider values in the SQLite example.

### Compatibility

- Custom headers preserve case-insensitive ownership checks: reserved authentication, protocol, transport, and SDK headers cannot be silently overwritten. Credentials remain configured through the provider's auth options.
- Gateway compatibility still requires the matching wire protocol: Responses for OpenAI generation, Messages for Anthropic, and Interactions for Gemini.
- Filesystem storage remains only a Node-wrapper default. Database stores use the existing `read`/`commit` contract; Copilot API-token caching can use custom `acquire`/`invalidate` hooks.
- Codex refresh tokens rotate. Applications must coordinate concurrent refreshers across workers with an account-level lock or shared auth service; revision checks alone do not serialize OAuth requests.

### Release scope

- All 24 workspace SDK packages, root metadata, and `SDK_VERSION` move from `0.1.1` to `0.1.2` to satisfy the existing lockstep release workflow. The private testkit remains unpublished.
- Behavioral/API changes are in `provider-http`, `provider-openai`, `provider-anthropic`, `provider-gemini`, `provider-codex`, `provider-copilot`, and `auth-node`; core also updates SDK version attribution. Other packages receive the lockstep version update.

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
- Updated the approved Anthropic SSE oracle for cumulative `usage-progress` snapshots and made main-branch releases gated, lockstep-checked, and safe to retry when a package version is already present on npm.
- Improved provider documentation and model limit guidance in English and Vietnamese.

### Release scope

- All workspace SDK packages move from `0.1.0` to `0.1.1` so the lockstep release workflow can publish a complete, internally compatible package set.
- `@alvin0/ai-agent-sdk-provider-copilot` and `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` are published for the first time at `0.1.1`.
- `@alvin0/ai-agent-sdk-testkit` remains private but carries the same workspace version.

## 0.1.0 - 2026-09-09

- Initial public release of the capability-based AI Agent SDK packages.
