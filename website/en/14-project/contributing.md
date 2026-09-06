# Contributing

## Setup

```bash
pnpm install --frozen-lockfile
pnpm workspace:build
pnpm build:cli
```

Node **22.12** or newer, pnpm **11.25.0**.

## Before you push

```bash
pnpm workspace:build
pnpm workspace:typecheck
pnpm build:cli
pnpm lint
pnpm exec tsc --noEmit
pnpm check:boundary-fixtures
pnpm check:supply-chain
pnpm test
pnpm test:packages
pnpm test:pack
```

That is exactly what CI runs. Running it locally first is cheaper than a red
pipeline.

## The rules a change must respect

**Runtime tiers.** A Universal package may not import a Node package or builtin.
An Edge journey may not be elevated by a Node capability. The static gate rejects
both.

**Public surface.** Preservation is the default. Journey declarations cannot
authorize deletion of an unmentioned symbol — every removal needs an approved
decision plus a consumer migration path.

**Adapters are the only layer that knows a wire format.** If a change teaches a
layer above an adapter about a provider's wire shape, it is the wrong change.

**No fabricated data.** Missing usage stays `missing`. An exporter never claims
durability it does not have. A budget that cannot be measured says so.

**Ownership is explicit.** A new capability declares its composition slot,
lifecycle, and who closes it.

## Adding a capability package

1. Add the package under `packages/`.
2. Register it in `design-contracts/core-capability-v1/topology.json` with its
   runtime tier, roles, composition slot, audience, and lifecycle rule.
3. Add an export map to `manifest-blueprints.json` — no wildcard routes, no
   `require` routes, explicit `"./package.json"`.
4. Add a consumer fixture under `consumers/` for the journey it enables.
5. Run `pnpm check:core-capability-contract`.
6. Add a README following the existing pattern: runtime tier, install command,
   usage, composition slot, lifecycle.

## Adding a provider

Most endpoints need **no new package** — see
[Adding a provider](/en/09-providers/custom-provider). If you are publishing one,
run the conformance suite:

```ts
import { runProviderConformanceSuite } from '@ai-agent-sdk/testkit'
const report = await runProviderConformanceSuite(fixture)
```

## Changesets

```bash
pnpm changeset
```

Describe the change from the consumer's point of view. A patch that removes or
narrows a public export is not a patch.

## Dependencies

New runtime dependencies need review. `pnpm check:supply-chain` enforces:

- SHA-512 integrity on every registry lock record;
- exact direct runtime pins, literal or via the strict catalog;
- lifecycle scripts against the reviewed `allowBuilds` allowlist;
- production SPDX expressions against the design allowlist;
- zero high/critical findings from `pnpm audit --prod`.

Any exception must record package, exact version, rationale, owner, and expiry in
[the dependency policy](/en/14-project/dependency-policy).

`dangerouslyAllowAllBuilds` is **forbidden**.

## Human acceptance

Some behaviour cannot be proven deterministically. When a change touches the
loop, provider behaviour, or an integration boundary, run the relevant harness
and record what you observed:

```bash
npm run human:basic
npm run human:deep
npm run human:hil
npm run human:mcp        # credential-free
```

Live-provider, network, and credentialed paths remain explicitly bounded manual
acceptance routes.

## Commit and PR

Commits use conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
The repository's recent history is the best style reference.

## Read next

- [Testing and acceptance](/en/14-project/testing)
- [Design contracts](/en/11-internals/design-contracts)
- [Dependency policy](/en/14-project/dependency-policy)
