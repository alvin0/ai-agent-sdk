# Multiple-agent quality follow-up — 2026-09-27

The final v7 candidate removes SDK-mandated progress narration by default and fixes disabled-tool guidance, and shortens generic dependency/protocol descriptions. The default commentary style is now `auto`; explicit `concise` and `off` remain available. This is a public default behavior change: hosts requiring progress narration should request `concise`. The chat sample already does so. Caller-defined workflows, roles, tools and output contracts remain host-owned; lower-level team/session APIs and manual/full/reporting policies remain available.

Strict quality gate: **NOT MET**. Paired efficiency/usage gate: **PASS**. These are descriptive results on six author-exposed lifecycle families, not a universal no-regression guarantee.

Compared with v10 in the same final cohort, Codex improves 31/36 → 36/36 and ZenMux 18/36 → 30/36, with zero new paired losses for both. Paired tokens and latency decrease for both providers. The global quality gate is still not met: ZenMux has two new primary losses versus the original BASE, and six candidate failures total. All six return unknown/null correctly but use the worker address as an evidence ID; their primary grades stay failed.

## Quality and performance

| Provider | Original BASE correct | v10 REFERENCE correct | v7 correct | Wins / new losses vs BASE | Wins / new losses vs v10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| codex | 19/36 | 31/36 | 36/36 | 17 / 0 | 5 / 0 |
| zenmux | 9/36 | 18/36 | 30/36 | 23 / 2 | 12 / 0 |

Paired-success means below use the identical successful, complete-usage pairs against v10. They are conditional, and share the same candidate rows as the BASE comparison. All attempts, failures, usage gaps and dispatch counts remain in the raw reports.

| Provider | Complete-success pairs | Tokens before → after | Token change | Latency before → after (ms) |
| --- | ---: | ---: | ---: | ---: |
| codex | 31 | 2481.2 → 2208.9 | -10.97% | 11050 → 9583 |
| zenmux | 18 | 4846.9 → 3427.1 | -29.29% | 13355 → 12080 |

Incomplete reported token subtotals remain incomplete. No USD, production-distribution, cross-provider billing, or statistical-superiority claim is made.

## Mechanisms and verification

- The old `concise` default appended mandatory progress narration after caller instructions. Chat-style providers can return that prose with final JSON. The `auto` default leaves narration to caller/model policy without stripping output, changing reasoning effort, or limiting tool use.
- Controlled public-boundary probes confirm `workerTeamTools:false` supplies no team tools or advertised team tool verbs. Private attachment access now preserves false; reporting/full remain available. The strengthened public conformance assertion checks both tools and advertised system verbs for false/reporting/full policies; it fails on the old reference (32/33) and passes on v7 (33/33). The conformance CLI now returns a nonzero exit status for failed cases after preserving all results; both exit statuses are verified.
- Four new model-boundary tests verify the default and explicit styles across an actual tool round, preserving caller instructions and tool execution.
- Routing addresses, actual result payloads and missing/partial results are labeled separately. The SDK does not insert a domain schema, expected answer or source-ID oracle.
- Terminal response is the task return value; quiet context messages do not substitute it. Generic descriptions are shortened without changing tool capabilities.
- Dependency reports identify full versus truncated payloads. The scoped reader returns the same retained observation and still supports closed original producers, byte caps and Unicode boundaries.
- 236 files / 3,046 tests and 33/33 public conformance pass, along with root/core typechecks, architecture lint and core pack/publint/public types. Isolated v7 builds all 26 packages.
- The refused-handoff fixture rejects the second lead→consumer delivery, rather than a prose prefix. The intermediate mistakenly rejected initial task and failed; failed logs remain retained.
- Analyzer independently recomputes frozen primary grades from raw text. Forged grades, fixture drift and missing/duplicate attempts are rejected.

## Native tool acceptance

| Provider | Real spawn | Both real measurement tools | Dependency consumer | Exact final answer |
| --- | --- | --- | --- | --- |
| codex | PASS | PASS | PASS | PASS |
| zenmux | PASS | PASS | PASS | PASS |

Native acceptance is candidate-only and separate from the paired benchmark. Each worker reads supplied in-memory facts with read-only authority; zero observed effects does not prove arbitrary external-tool safety.

## Evidence, failures and limits

- [Controlled policy probe](policy-v7/results.json), [final public conformance](conformance-v7-r3/results.json), [old-reference regression](conformance-reference-policy-regression-r2/results.json) and [verified exit codes](conformance-policy-verification-v7.json).
- [Final quality gates](formal-v7/quality-report.json), [comparison versus v10](formal-v7/comparison-reference/report.json), [comparison versus original BASE](formal-v7/comparison-base/report.json), and [all 216 raw attempts](formal-v7/runs.jsonl).
- [All strict failures versus v10](formal-v7/comparison-reference/failure-review.json) and [new raw losses](formal-v7/comparison-reference/new-losses.json); original BASE review is retained alongside. A correct embedded JSON answer remains a primary format failure.
- Failed-source task does not explicitly specify empty IDs, while the unchanged oracle requires verified payload IDs. Addresses in `sourceIds` remain primary failures; they are not favorably regraded.
- [Pilot v1](pilot-v1/quality-report.json), [full v1](formal-v1/quality-report.json) and [full v3](formal-v3/quality-report.json) and [full v4](formal-v4/quality-report.json) are retained separately, including failed quality/efficiency gates. v2 and v5 were built but never measured live. v6 failed typechecks because its first disabled-tool fix compared a string-only access type to false; it was blocked from live measurement. v7 corrects the private type and attachment normalization. Failed gates/probes remain retained.
- Six families × two translations × three repeats × three arms × two providers = 216 final attempts; translations/repeats share facts. Six order permutations balance across the cohort, not within each language. One active workflow per provider; no selective retries or best-of rows.
- Host controls scheduling in the cohort. Autonomous planning has only the separate native smoke; broader unseen workloads remain unverified.
- This candidate combines several changes. Controlled probes establish policy consistency, not each change’s individual contribution to live gains; no isolated ablation or statistical-superiority claim is made.
- Every cohort pins fixture/oracle, model/effort/limits and all built SDK hashes. Exact harness source, full source patches, build freezes and validation logs are retained. No env/auth store or HTTP bodies are copied.

The retained v3 observer initially started before the result file existed. It failed without starting a native workflow; the main paired cohort continued unchanged. A separate observer recovery started after the file existed and scheduled the native checks once. Original failure and recovery logs/source are retained. No attempt, arm or grade was retried. The original parent helper reports that observer failure even though the main cohort completes; the final integrity/coverage checks and independent recovered observer establish completion.

## Ownership

The staged index is unchanged. These fixes are in the working tree; existing staged intermediate code is not the measured final source. No staging, commit, reset, stash or checkout was performed. See [verification](verification.json) and [final source freeze](candidate-freeze-v7.json).
