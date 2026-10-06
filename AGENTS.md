# Project instructions

@C:\Users\dinh-ai\.codex\RTK.md

## OpenAI model policy

- Use `gpt-6-luna` as the minimum and default OpenAI generation/decision model for project examples, smoke tests, benchmarks, and real API calls. A newer model may be selected explicitly.
- Do not select or recommend older OpenAI models, including through environment overrides. Do not fall back to an older model after an API error or an unavailable model; report the error instead.
- When updating an OpenAI example or live runner, use `gpt-6-luna` or a newer explicitly selected model. This is project usage policy; keep SDK provider/model selection configurable for consumers.
- Historical reports and offline protocol fixtures may retain model identifiers as recorded evidence; they are not model recommendations or permission to make live calls with those models.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
