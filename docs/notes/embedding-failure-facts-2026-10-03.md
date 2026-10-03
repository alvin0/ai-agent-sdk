# Embedding terminal provider facts

The embedding retry ledger wrapped a provider `ModelError` in `EmbeddingError`
without carrying its HTTP status, retry delay, or request identifier. Downstream
`normalizeModelFailure()` therefore retained the error code but lost facts needed
to distinguish authentication, rate-limit, and server failures in diagnostics.

`EmbeddingError` now carries the same validated, frozen `ModelFailure` envelope
as `ModelError`. It remains an `AgentSdkError`, and an existing `EmbeddingError`
retains its identity. The wrapper copies available provider facts; it does not
change retry decisions, attempt limits, backoff, embedding inputs, or vectors.
No input text or raw cause body is added to the failure envelope.

Verification in the isolated checkout:

- Full workspace build passed. The core build was copied into an isolated Zeus
  checkout and exercised through its local HTTP embedding adapter.
- Embedding unit and contract suites: 289 tests in 23 files passed.
- Root TypeScript check passed.
- Core package export lint and public declaration checks passed.
- Package graph, dependency, agent, and runtime boundary checks passed with Node
  24.19.0. The initial lint invocation used unsupported Node 25.6.1; no dependency
  or source changes were required to use the supported runtime.
- Fixtures cover fatal HTTP 401, exhausted HTTP 429/503, cross-copy normalization,
  existing error identity, unavailable facts, and invalid HTTP fact validation.

This is a diagnostic repair. It does not establish provider availability,
retrieval quality, or a latency improvement. No real provider request or SDK push
was performed for this change.
