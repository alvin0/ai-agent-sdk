# I8 final gap matrix and release decision

## Decision

**NO-GO for release-readiness under the currently approved budgets.** The
implementation, installed-package, Web/Node runtime, authenticated human and
recovery gates are complete, but the basic public Edge agent bundle is 96,014
gzip bytes against the approved 70,000-byte ceiling. Publishing is out of scope
and was neither configured nor attempted.

This is not a claim that the SDK is unusable. It is a refusal to silently change
an approved performance contract. The owner can open a separate optimization
workstream or explicitly approve a revised basic-agent budget.

## Gap matrix

| Area | Evidence | Result | Release effect |
| --- | --- | --- | --- |
| Target package topology | 18 packed packages; 32 NodeNext routes; 20 Browser/workerd routes; one physical core | Pass | None |
| Core contracts bundle | 13,154 gzip bytes <= 14,000 | Pass | None |
| Basic public Edge agent bundle | 96,014 gzip bytes > 70,000 | **Fail** | **Blocking** |
| Complete core runtime payload | 124,530 gzip bytes <= 127,739 using the documented stable aggregate method | Pass | None |
| Workerd heap samples | Contract 933,808-byte peak; basic agent 7,996,992-byte peak and 6,345,400-byte sampled delta | Pass with sampling limitation | None |
| Runtime dependencies | 18 targets; 6 unique direct third-party roots; 20 unique installed third-party packages | Pass | None |
| SSE parser ownership | Exact `eventsource-parser@4.1.0`, outside core; owned replacement candidate failed throughput gates | Pass/retain | None |
| Node full-SDK human journey | Filesystem skills, MCP stdio, persistence, cancellation, journal recovery, usage and diagnostics | Pass | None |
| Edge Web Standards journey | Real browser UI and agent runtime execute under strict workerd; visible SSE/tool process and bounded close | Pass | None |
| Direct workerd transport to the ChatGPT-backed Codex endpoint | Authenticated request reaches upstream but receives HTTP 403 | External limitation | Non-blocking for generic provider architecture; do not claim direct Codex transport support |
| Test-only authenticated Codex transport | Loopback-only bounded relay; exact target/route/header allowlists; credentials excluded from browser/artifacts | Pass | Human-test mechanism only, never a production recommendation |
| Real deep research | Luna: 5 native searches, 12 reads, 4 domains, two audits, 23,074 report characters | Pass | None |
| Evidence repair | Audit round 1 rejected a foreign receipt; round 2 repaired traceability without hiding four honest gaps | Pass | None |
| Model-specific fallback | Spark primary failed to finish; Luna fallback passed; independent usage/artifacts linked by recovery summary | Pass | None |
| Independent semantic review | Primary marked fail; fallback marked pass after primary-source cross-check | Pass | None |
| Publish | No publish lifecycle step and no npm release performed | Out of scope | None |

## Human evidence

- Passing standalone Luna acceptance:
  `test-human/results/edge-chat-live/edge-live-relay-luna-15/`
- Failed Spark primary and passing automatic fallback:
  `test-human/results/edge-chat-live/edge-live-auto-recovery-16/`
  and
  `test-human/results/edge-chat-live/edge-live-auto-recovery-16-fallback-gpt-5.6-luna/`
- Recovery linkage:
  `test-human/results/edge-chat-live/edge-live-auto-recovery-16-recovery/summary.json`
- Node control:
  `test-human/results/human/core-capability-node-deep-research/`

Each model call in the passing Edge artifact reported authoritative usage. The
fallback run used 207,830 total tokens across six complete model calls and had
zero missing usage records. Its final `review.json` is an independent decision,
not an agent self-rating.

## Required next decision

Choose one in a later workstream:

1. optimize optional agent features out of the basic public Edge bundle until it
   is at or below 70,000 gzip bytes; or
2. approve a new measured budget with an explicit rationale and update the
   frozen contract.

Until then, the current release-readiness decision remains **NO-GO**.
