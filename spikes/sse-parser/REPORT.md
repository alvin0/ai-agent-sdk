# SSE parser qualification report

Date: 2026-09-01  
Reference: exact-pinned `eventsource-parser@4.1.0`  
Candidate status: **not qualified for production replacement**

## Result

The owned candidate is correct enough to remain useful as a research artifact,
but it does not meet the predeclared replacement gate. The production dependency
must remain pinned at `4.1.0` for this release.

The parser passed the WHATWG-oriented conformance corpus, typed resource-limit
tests, fail-closed cancellation, 100,000 deterministic differential chunk
partitions, and 1,000,000 deterministic byte-fuzz seeds. There were no differences
in events, comments, IDs, or retry values.

There were 12,724 diagnostic-only differences. The candidate reports completed
unknown fields consistently; the reference intentionally stops buffering a line
as soon as its prefix cannot become a recognized field, so whether its optional
`onError` callback observes that unknown field can depend on chunk boundaries.
Unknown fields are ignored by WHATWG and the SDK does not expose these diagnostics,
so this is recorded but is not a provider-visible semantic mismatch.

## Failed gate

The benchmark gate allows at most 20% regression. Median isolated measurements
showed candidate throughput regressions of 75.65% for single-line JSON, 71.68% for
mixed fields/comments, and 83.13% for large multiline data. Peak RSS regressed by
2.72%, which passed, but every throughput workload failed decisively.

The exact machine-readable measurements, deterministic seeds, digests, corpus
size, and bounds are archived in [`report.json`](./report.json). Reproduce with:

```sh
node --expose-gc spikes/sse-parser/evaluate.ts
```

## Security interpretation

Keeping the dependency is not a claim that third-party code is risk-free. It is
the result of the project's deterministic rule: an owned replacement may land only
when it is at least as correct, bounded, cancellable, integrated, and no more than
20% slower or more memory-hungry. Until then, risk is controlled with the exact
version pin, lockfile integrity, install-script allowlisting, age/trust policy,
license checks, production audit, packed-artifact tests, and release suspension for
any high or critical advisory affecting the pin.
