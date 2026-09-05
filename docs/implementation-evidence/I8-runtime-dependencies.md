# I8 runtime dependency evidence

## Scope

This evidence recounts production runtime dependencies for every package in the
target topology. It does not infer counts from the lockfile alone.

The machine-readable snapshot is
[`runtime-dependency-report.json`](../../design-contracts/core-capability-v1/runtime-dependency-report.json).
The drift gate is [`check-runtime-dependency-report.mts`](../../scripts/check-runtime-dependency-report.mts).

## Method

For each of the 18 target packages, the gate runs:

```text
pnpm --filter <package> list --prod --depth Infinity --json
```

It recursively walks installed production dependencies, excludes workspace
packages, adds required external runtime peers, and compares exact sorted
package-and-version entries with the checked report. It separately derives the
direct third-party roots from topology policy, so a transitive dependency cannot
be misreported as direct.

## Verified result

Command:

```text
pnpm check:runtime-dependencies
```

Result on 2026-09-05:

```text
Runtime dependency report passed: 18 target packages, 6 unique direct roots,
20 unique installed packages.
```

The direct roots are `@a2a-js/sdk`, the three selected MCP packages,
`@opentelemetry/api`, and `eventsource-parser@4.1.0`. The MCP client closure also
contains its upstream `eventsource-parser@3.1.1`; that version is transitive and
is not owned by the SDK HTTP/provider layer.
