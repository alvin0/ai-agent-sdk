# Dependency and supply-chain policy

The machine-enforced source of truth is `pnpm-workspace.yaml` and
`pnpm-lock.yaml`. This page records the narrow reviewed exceptions.

## What the gate enforces

```bash
pnpm check:supply-chain
```

- **SHA-512 integrity** on every registry lock record; exotic and non-registry
  resolutions are rejected.
- **Exact direct runtime pins**, either literal or through the strict catalog.
- **Lifecycle scripts** checked against the reviewed `allowBuilds` entries below.
- **Production SPDX expressions** checked against the design allowlist.
- **Zero high/critical findings** from `pnpm audit --prod`.

The checker reads the committed lockfile and installed manifests **after the
frozen install**. It does not download or execute a package for inspection.

`strictDepBuilds: true` is enabled. `dangerouslyAllowAllBuilds` is **forbidden**.

## Reviewed lifecycle scripts

Only these packages may run install scripts.

| Package | Version | Script | Why execution is required | Owner | Review expiry |
| --- | --- | --- | --- | --- | --- |
| `esbuild` | `0.28.1` | `node install.js` | Verifies/selects the registry-pinned platform binary used by Vite/tsdown. Builds and browser tests require the executable. | SDK maintainers | 2026-12-01 |
| `esbuild` | `0.18.20` | `node install.js` | Drizzle Kit tooling dependency; the install script selects the exact optional platform package and checks its version. | SDK maintainers | 2026-12-01 |
| `esbuild` | `0.25.12` | `node install.js` | Drizzle Kit tooling dependency; the install script selects the exact optional platform package and checks its version. | SDK maintainers | 2026-12-01 |
| `workerd` | `1.20260828.1` | `node install.js` | Verifies/selects the registry-pinned platform binary used by Wrangler for strict Worker tests. | SDK maintainers | 2026-12-01 |

All are registry tarballs with lockfile integrity, and their platform binaries
are expressed as **exact-version optional dependencies**.

An upgrade must re-audit the package, version, lifecycle script, source,
integrity, and platform dependency set **before** changing the allowlist.

## SSE parser retention

The workspace retains exact `eventsource-parser@4.1.0` in
`@alvin0/ai-agent-sdk-provider-http` after the owned-parser candidate failed its
**predeclared performance gate**. The rule and its evidence live in
`docs/dependency-policy.md`.

| Property | Status |
| --- | --- |
| Lifecycle script | None |
| Direct owner | `@alvin0/ai-agent-sdk-provider-http` only |
| Registry integrity, license, frozen resolution | Release gates |
| Packed runtime behavior | Release gate |
| Advisories | Release gate |

A high or critical advisory **suspends release** rather than authorizing an
automatic upgrade or an unqualified fallback. The 2026-09-01 production audit
found zero advisories at every severity.

## Skill metadata YAML parser

`@alvin0/ai-agent-sdk-skill-filesystem` directly owns exact `yaml@2.9.0`. It parses the
bounded `agents/openai.yaml` policy with aliases disabled and rejects duplicate,
malformed, over-deep, or oversized metadata. Integrity, ISC licensing, packed
runtime behavior, and advisories are release gates. Review expiry: 2026-12-06.

## Release-age decision

On 2026-09-01, pnpm correctly rejected `@opentelemetry/api-logs@0.222.0`: it had
been published less than 24 hours earlier. The workspace pins the mature
`0.221.0` release rather than bypassing `minimumReleaseAge: 1440`.

The OpenTelemetry adapter must run its API compatibility suite against that exact
version before extraction.

## CI action provenance

The required workflow pins official GitHub actions to **immutable signed release
commits**:

| Action | Release | Commit |
| --- | --- | --- |
| `actions/checkout` | `v7.0.0` | `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` |
| `actions/setup-node` | `v6.0.0` | `2028fbc5c25fe9cf00d9f06a71cc4710d4507903` |

The workflow installs `pnpm@11.25.0` exactly, **with lifecycle scripts
disabled**, before running the frozen workspace install.

## Adding an exception

Any future exception must record, in `docs/dependency-policy.md`:

- package
- exact version
- rationale
- owner
- review expiry

An exception without an expiry date is not an exception — it is a permanent
liability.

## Read next

- [Contributing](/en/14-project/contributing)
- [Security and privacy](/en/10-advanced/security)
