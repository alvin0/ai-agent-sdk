# ADR 0001: Retain the exact-pinned SSE parser for 0.x

- Status: Accepted
- Date: 2026-09-01
- Owners: provider transport and supply-chain maintainers
- Scope: `@ai-agent-sdk/provider-http`

## Context

The Universal HTTP provider needs incremental UTF-8 Server-Sent Events framing.
`eventsource-parser` is a small but security-sensitive production dependency because
every streamed provider response passes through it. Removing it would reduce one
direct third-party execution surface, but an incomplete or materially slower owned
parser would transfer protocol, denial-of-service, and maintenance risk into this
repository.

The project declared the replacement rule before implementing a candidate: every
WHATWG conformance, differential, deterministic fuzz, resource, cancellation,
provider-integration, and review gate must pass, and throughput or peak memory may
not regress by more than 20% without a documented correctness or security reason.
An almost-compatible implementation is not eligible.

## Decision

Retain exact `eventsource-parser@4.1.0` as the sole direct external runtime
dependency of `@ai-agent-sdk/provider-http` for the 0.x release line. Do not copy,
vendor, or promote the owned spike into production.

The candidate passed its semantic, resource, cancellation, 100,000-partition
differential, and 1,000,000-seed fuzz gates. It failed all three throughput gates by
71.68% to 83.13%, far above the allowed 20%. This single failed mandatory gate
selects the retain outcome. The exact evidence and seeds are archived in
[`spikes/sse-parser/report.json`](../../spikes/sse-parser/report.json) and summarized
in [`REPORT.md`](../../spikes/sse-parser/REPORT.md).

The 12,724 differential diagnostic differences are also retained. They concern
only the optional unknown-field error callback: the reference discards impossible
field prefixes early, while the candidate reports the completed ignored field.
Events, comments/activity, IDs, and retry values have zero differences. This is not
the reason for retention; the benchmark failure is sufficient.

## Required controls

- Keep `4.1.0` exact in `packages/provider-http/package.json`; no range and no other
  direct owner.
- Keep registry integrity in the pnpm lock and use frozen installs.
- Deny dependency lifecycle scripts unless separately reviewed and allowlisted.
- Enforce minimum release age, no-downgrade trust policy, registry-only sources,
  reviewed runtime licenses, package graph ownership, packed runtime tests, and
  production advisory scanning.
- Convert `max-buffer-size-exceeded` into an immediate provider-attempt failure;
  never treat parser overflow as clean EOF.
- Keep wrapper-level limits for total decoded events as well as response bytes,
  raw chunks, and per-event buffered characters. Parser callbacks are drained in
  linear time; a single input chunk must not create an `Array.shift()` O(n²)
  path.
- Require `text/event-stream` before parsing, route every non-empty body read
  (including comment heartbeats) to the attempt's one resettable idle deadline,
  ignore SSE `retry` as reconnection policy, and require a terminal protocol
  `finish` before clean EOF.
- Preserve the primary parser/protocol error if bounded reader cancellation also
  fails; report teardown failure as secondary evidence.
- Suspend release if a high or critical advisory affects `4.1.0`. Do not silently
  upgrade the pin or waive the qualification rule.

The workspace also contains `eventsource-parser@3.1.1` transitively through the
optional MCP client stack (`@modelcontextprotocol/client@2.0.0` and
`eventsource@3.0.7`). It is not a direct SDK dependency, is outside the Universal
root-only closure, and remains covered by lock integrity and production audit. This
ADR does not misrepresent that transitive edge as owned provider code.

## Verification

On 2026-09-01, `pnpm audit --prod --json` reported 19 production dependencies and
zero info, low, moderate, high, or critical advisories. Package graph, runtime
boundary, supply-chain, typecheck, and the provider's packed Node/Chromium/Worker
fixtures were already green at the retained pin.

## Consequences and reconsideration

The Universal root install continues to include one direct third-party SSE parser.
Users selecting MCP can additionally receive the upstream MCP parser closure. The
blast radius remains capability-local rather than entering core or agent.

Reconsider only in a new ADR with a new candidate and fresh evidence. A candidate
must meet every existing gate; an advisory blocks release but does not authorize an
untested internal parser or an automatic version change.
