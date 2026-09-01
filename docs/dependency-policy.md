# Dependency and Supply-Chain Policy

This file records the narrow exceptions required by the workspace security configuration. The machine-enforced source of truth remains `pnpm-workspace.yaml` and `pnpm-lock.yaml`.

## Reviewed lifecycle scripts

`strictDepBuilds: true` remains enabled. Only the following packages may run install scripts; `dangerouslyAllowAllBuilds` is forbidden.

| Package | Version reviewed | Script | Why execution is required | Registry integrity | Owner | Review expiry |
|---|---:|---|---|---|---|---|
| `esbuild` | `0.28.1` | `node install.js` | Verifies/selects the registry-pinned platform binary used by Vite/tsdown. Builds and browser tests require the executable. | `sha512-HrJrvZv5ayxBzPfwphOoNzkzOIIlifzk0KJrGK2c8R4+LKpMtpYLQeUdjnwjWv/LZlkH2laZk+4w78pi99D4Vw==` | SDK maintainers | 2026-12-01 |
| `workerd` | `1.20260828.1` | `node install.js` | Verifies/selects the registry-pinned platform binary used by Wrangler for strict Worker tests. | `sha512-pB9yvt0kkwZDAGZHmpY59r0o3hM0DzdW6BJERqwZOhunZ3ssOyDSgQxOQer2cSZW4YCFeOTIQYN1qwhK5wv/Cw==` | SDK maintainers | 2026-12-01 |

Both packages are registry tarballs with lockfile integrity and platform binaries expressed as exact-version optional dependencies. An upgrade must re-audit the package, version, lifecycle script, source, integrity, and platform dependency set before changing the allowlist.

## Release-age decision

On 2026-09-01, pnpm correctly rejected `@opentelemetry/api-logs@0.222.0`: it had been published less than 24 hours earlier. The workspace pins the mature `0.221.0` release instead of bypassing `minimumReleaseAge: 1440`. The OpenTelemetry adapter must run its API compatibility suite against this exact version before extraction.

## Runtime dependency review

The lockfile-only checker introduced in W1 owns registry source, integrity, exact direct runtime version, lifecycle-script, license, and production-advisory enforcement. Any future exception must include package, exact version, rationale, owner, and expiry in this file.
