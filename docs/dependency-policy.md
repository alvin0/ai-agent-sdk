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

`pnpm check:supply-chain` now enforces:

- SHA-512 integrity on every registry lock record and rejects exotic/non-registry resolutions;
- exact direct runtime pins, either literal or through the strict catalog;
- lifecycle scripts against the reviewed `allowBuilds` entries above;
- production SPDX expressions against the design allowlist; and
- zero high/critical findings from `pnpm audit --prod`.

The checker reads the committed lockfile and installed manifests after the frozen install. It does not download or execute a package for inspection. Any future exception must include package, exact version, rationale, owner, and expiry in this file.

## CI action provenance

The initial required workflow pins official GitHub actions to immutable, signed release commits:

| Action | Release | Commit |
|---|---:|---|
| `actions/checkout` | `v7.0.0` | `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` |
| `actions/setup-node` | `v6.0.0` | `2028fbc5c25fe9cf00d9f06a71cc4710d4507903` |

The workflow installs `pnpm@11.25.0` exactly with lifecycle scripts disabled before running the frozen workspace install.
