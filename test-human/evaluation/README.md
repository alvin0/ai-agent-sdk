# Neutral SDK before/after evaluation

Run from the workspace root after `rtk proxy pnpm build`. Node 22.18+ is required.
Codex uses the SDK's existing credential store (`.providers/.codex/auth.json`,
or `AI_AGENT_SDK_CODEX_AUTH`); credentials are never copied into artifacts.

```sh
rtk proxy node --env-file=.env --experimental-strip-types test-human/evaluation/runner.ts --phase pilot --provider codex --model gpt-6-luna --effort medium --run-id my-pilot
rtk proxy node --env-file=.env --experimental-strip-types test-human/evaluation/runner.ts --phase baseline --provider codex --model gpt-6-luna --effort medium --repeats 5 --run-id my-baseline
rtk proxy node --experimental-strip-types test-human/evaluation/analyze.ts artifacts/neutral-evaluation/my-baseline
```

60 synthetic families cover ten domains: code, data, documents, historical
decisions, operations, business, support, planning, language, and simple controls.
20 development and 10 calibration cases run once; 30 held-out families are
scheduled five times. Two held-out feature families are explicitly unsupported:
real durable restart and durable owner generation. This produces **170 live
attempts plus two unsupported records**. Two prose families produce ten review
requests, not automatic quality passes. “Held-out” here describes the split,
**not blindness**: the author has seen all synthetic fixtures.

The output directory is created exclusively; an existing run cannot be overwritten.
It contains the revision, SDK source archive and diff, lockfile hash, frozen runner,
grader and fixtures, configuration, per-attempt JSONL, summary and SHA-256 checksums.
JSONL is written after every attempt, including errors. Interruptions leave partial
records; the analyzer refuses incomplete runs. Failed preflight/pilot directories
remain separate and never enter the main score. No raw HTTP bodies, tokens, account
IDs, headers, external repository data or credential files are recorded.

Use the **same frozen harness**, seed, model/effort, limits, lockfile and tools after
changes, choosing `--phase after` and a new run id. Rebuild the SDK first. Then:

```sh
rtk proxy node --experimental-strip-types test-human/evaluation/analyze.ts artifacts/neutral-evaluation/my-baseline artifacts/neutral-evaluation/my-after
```

Comparison rejects mismatched configuration and pairs family/repeat. Quality CIs
resample whole families; prose is reviewed separately. All-attempt latency and token
totals are descriptive, not efficiency wins. Only equivalent successfully completed
tasks may support an efficiency claim. Token totals do not represent currency cost.
Sequential-before-after cannot eliminate model or service drift; stronger claims
require a pinned model plus interleaved baseline/control replay.

`runner-paired.ts` / `analyze-paired.ts` compare PTC on/off on the **same current
SDK**. They are an ablation, not a replay of the original SDK against the final
bundle, and cannot close the bundle comparison required by evaluation spec §8.
The analyzers require exact family/repeat/arm coverage and mandatory checksums;
duplicate records cannot replace missing attempts just by preserving row count.

This initial cohort exercises the real AgentRuntime with synthetic host tools,
pagination/spill, host denial, factual/source checks, multilingual extraction, and
short session history. It **does not** prove real compaction recall, scoped database
retrieval, guest isolation, network/stream faults, remote process behavior, or durable
crash recovery. Existing deterministic tests complement it; dedicated spike harnesses
must supply the missing capability gates before productization. Do not tune the
frozen grader or fixtures against failed baseline/after results; version a new cohort
and retain the old one if a protocol defect is discovered.

## Original SDK against the final bundle

`cohort-v2.ts` supplies 120 matched Vietnamese/English variants of the same 60
families. It retains the original split and synthetic evidence and adds executable
patch grading, private-contact redaction, real manual compaction, and host constraint
revision during a model round. Mixed-language source text stays unchanged. It remains
an author-exposed regression cohort; translations do not create independent families.

`runner-bundles.ts` forks two processes, each resolving packages from its own built
SDK snapshot. The baseline is extracted from the frozen original source archive;
the candidate applies the current production/sample patch to that archive. Neither
process switches the user's checkout. `loaded-bundles.json` proves the loaded session
module differs and only the candidate contains the experimental nested port.

```sh
rtk proxy node --experimental-strip-types test-human/evaluation/prepare-bundles.ts --baseline artifacts/neutral-evaluation/codex-luna-baseline-20260926-v1 --output artifacts/my-prepared-bundles
rtk proxy node --experimental-strip-types test-human/evaluation/preflight-bundles.ts artifacts/my-prepared-bundles
rtk proxy node --env-file=.env --experimental-strip-types test-human/evaluation/runner-bundles.ts --preparation artifacts/my-prepared-bundles --phase pilot --provider codex --model gpt-6-luna --run-id my-bundle-pilot
rtk proxy node --env-file=.env --experimental-strip-types test-human/evaluation/runner-bundles.ts --preparation artifacts/my-prepared-bundles --phase final --provider codex --model gpt-6-luna --run-id my-bundle-final
rtk proxy node --env-file=.env --experimental-strip-types test-human/evaluation/review-prose.ts --source artifacts/neutral-evaluation/my-bundle-final --model gpt-6-sol --run-id my-blind-prose-review
rtk proxy node --experimental-strip-types test-human/evaluation/analyze-bundles.ts artifacts/neutral-evaluation/my-bundle-final artifacts/neutral-evaluation/my-blind-prose-review
rtk proxy node --experimental-strip-types test-human/evaluation/review-losses.ts artifacts/neutral-evaluation/my-bundle-final artifacts/neutral-evaluation/my-blind-prose-review
```

The loss queue is a review deliverable, not an automatic adjudication. Inspect every
listed prompt, oracle, output and trace, record the reason and disposition separately,
and retain the original failing grade. A completed experiment can conclude
`no-go` or `inconclusive`; completing the plan does not require a passing quality gate.

For the preregistered OFF cohort, bind the prose review to the corresponding final
candidate outputs before comparing:

```sh
rtk proxy node --env-file=.env --experimental-strip-types test-human/evaluation/runner-bundles.ts --preparation artifacts/my-prepared-bundles --phase ablation --provider codex --model gpt-6-luna --run-id my-bundle-off
rtk proxy node --env-file=.env --experimental-strip-types test-human/evaluation/review-prose.ts --source artifacts/neutral-evaluation/my-bundle-off --reference artifacts/neutral-evaluation/my-bundle-final --model gpt-6-sol --run-id my-off-prose-review
rtk proxy node --experimental-strip-types test-human/evaluation/analyze-ablation.ts artifacts/neutral-evaluation/my-bundle-final artifacts/neutral-evaluation/my-bundle-off artifacts/neutral-evaluation/my-blind-prose-review artifacts/neutral-evaluation/my-off-prose-review
```

OFF runs after the interleaved comparison, so timing drift remains a limitation.
The frozen ten-family selection covers nine domains (two DATA families, no PLAN
family), with only one family in most domains. It cannot estimate within-domain
family uncertainty; the ablation reports descriptive differences with an
unavailable confidence interval.

Final schedules **560 live attempts and eight unsupported records per model**:
28 COMMON held-out families, two languages, five repeats, two arms; two FEATURE
families remain unsupported. Replication uses the same schedule. Ablation freezes
ten families before results and schedules 100 OFF attempts on the final SDK.
Prose review uses a different model, shuffled anonymous A/B labels and a frozen
factual rubric. One model reviewer is assistance, not human consensus. It cannot
override deterministic arithmetic, schema, state, authority or leakage failures.
`review-integrity.ts` binds scores to raw-output hashes and rejects invalid mappings.

Both arms have identical read-only host authority, root budgets and ordinary tools;
PTC is enabled only for preregistered data/business target families. A common raw
result cap of 64 KiB admits every fixture; the separate model-facing cap stays
2,048 tokens and triggers spill. `fixtureSizeAudit` rejects inaccessible fixtures
before any remote model request. The original v1 and v2.1 8 KiB configuration made
large outputs inaccessible; those attempts remain protocol diagnostics and do not
enter the v2.2 final comparison.

Create `STOP` inside a run directory to stop before the next pair. Attempts are not
retried or selectively replaced. Partial cohorts remain evidence but cannot pass
coverage validation. Limits and token ceilings are frozen in each manifest; currency
pricing is unconfigured and no monetary savings conclusion is made.

`auditSnapshotAndEventBytes` measures serialized canonical history and host events,
including hidden child records. It does not measure model request bytes or guest
bytes. Usage reports treat `inputTokens` as uncached input, report cache counters
separately, and use `totalTokens` without adding reasoning tokens a second time.

The companion development value analyzer (`test-human/spikes/ptc-analyze.ts`) also
uses paired successful FILTER/JOIN tasks for both token and p95 latency gates.
Failed BASE timeouts cannot establish a latency saving. Category reports retain
all-attempt measurements separately, and complete usage remains a prerequisite
for the token gate.
