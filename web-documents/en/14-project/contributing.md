# Contributing

## Setup

```bash
pnpm install --frozen-lockfile
pnpm workspace:build
pnpm build:cli
```

Workspace development requires Node **22.18** or newer and pnpm **11.25.0**.
Published Node capability packages retain their Node **22.12** runtime floor.

## Before you push

```bash
pnpm workspace:build
pnpm workspace:typecheck
pnpm build:cli
pnpm test:lint
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

## Code quality limits

The root `eslint.config.mjs` applies to handwritten JavaScript and TypeScript,
including TSX, package sources, tests, scripts, samples, and documentation apps.
All limits are errors. `pnpm lint:code`, `pnpm lint`, and the CI maintainability
gate check `packages/`, including package tests, consumer fixtures, and configs.
Other directories use the same rules when targeted directly with ESLint.

| Measure | Maximum | Rule |
| --- | --- | --- |
| Characters per line (code and comments) | 120 | `@stylistic/max-len` |
| Physical lines per file, including blank lines and comments | 400 | `max-lines` |
| Lines per function, excluding blank and comment-only lines | 60 | `max-lines-per-function` |
| Statements per function | 30 | `max-statements` |
| Cyclomatic complexity per function (classic variant) | 10 | `complexity` |
| Cognitive complexity per function | 15 | `sonarjs/cognitive-complexity` |
| Nested block depth | 4 | `max-depth` |
| Nested callback depth | 3 | `max-nested-callbacks` |
| Parameters per function, excluding TypeScript `this` | 4 | `max-params` |
| Nested ternary expressions | Not allowed | `no-nested-ternary` |

These are project thresholds, not a universal definition of good design. Split
modules by responsibility and extract cohesive helpers; numeric limits alone
cannot prove that a module has a single responsibility. The statement and
complexity limits also catch functions compressed onto very few lines.

Line length includes imports, strings, templates, regular expressions, URLs,
and comments. Wrap imports and expressions, split long prose strings without
changing their value, and keep each physical line within the limit. No broad
test override or legacy baseline relaxes these limits. Large test suites should
be split into focused files and reusable setup helpers.

Dependencies, build output, explicitly listed cache directories, human
run outputs, and intentionally invalid boundary fixtures are excluded. Ordinary
package consumer fixtures remain checked. Output ignores are scoped to root,
package, and application output directories. Source files named `*.generated.ts`
or `*.min.js`, and source folders named `build` or `artifacts`, remain checked.
Any newly generated output needs an explicit, narrowly scoped ignore.

Inline ESLint configuration is prohibited. `eslint-disable` and comments that
change thresholds have no effect, and their warnings fail the zero-warning
gate. Necessary exceptions must be reviewed in the central configuration with
an exact scope and rationale; source comments cannot bypass these limits.

Hidden directories are not excluded wholesale: handwritten code such as
`.github/scripts/` and `.vitepress/config.ts` remains checked. Only the length of
framework suite registration callbacks (`describe()` or imported `suite()`) is
exempt in test files. Test cases, hooks, helper functions, and business functions
named `describe` retain the 60-line limit. Other rules, including file length,
statements, complexity and nesting, still apply to suite callbacks.

The test function-length rule delegates to ESLint's pinned built-in rule through
`eslint/use-at-your-own-risk`. It preserves ESLint's counting of methods,
comments, blank lines, and IIFEs. Run the lint regression suite when upgrading
ESLint; this adapter depends on that version's visitor contract.

Run `pnpm lint:source` to focus on SDK source under `packages/*/src` with the
same strict limits. Run `pnpm lint:code` for all package code checks, `pnpm lint:boundaries` for architecture
checks, and `pnpm test:lint` to verify enforcement without live provider calls.
`pnpm lint` runs every code and architecture gate even if an earlier gate fails,
and exits unsuccessfully if any gate fails. CI runs maintainability separately
so existing style violations cannot prevent boundary checks from running.
`pnpm lint:fix` runs supported autofixes, but these size and complexity rules
require manual formatting or refactoring. Existing violations fail immediately;
adding the configuration does not automatically refactor existing code.

The workspace compiler remains TypeScript 7. ESLint's parser uses a separately
pinned TypeScript 6 compiler API in the private `scripts/eslint-tooling` workspace, because
typescript-eslint does not yet support the TypeScript 7 API. See Microsoft's
[side-by-side guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).

Rule references: [ESLint complexity](https://eslint.org/docs/latest/rules/complexity),
[file length](https://eslint.org/docs/latest/rules/max-lines),
[function length](https://eslint.org/docs/latest/rules/max-lines-per-function),
and [ESLint Stylistic line length](https://eslint.style/rules/max-len).

## Adding a capability package

1. Add the package under `packages/`.
2. Add it to `PACKAGE_RULES` in `scripts/package-policy.mts` with its runtime
   tier, workspace dependencies, and external runtime dependencies.
3. Declare the export map in the package's own `package.json` — no wildcard
   routes, no `require` routes, explicit `"./package.json"`.
4. Add a consumer fixture under `consumers/` for the journey it enables.
5. Run `pnpm lint` and `pnpm check:docs`.
6. Add a README following the existing pattern: runtime tier, install command,
   usage, composition slot, lifecycle.

## Adding a provider

Most endpoints need **no new package** — see
[Adding a provider](/en/09-providers/custom-provider). If you are publishing one,
run the conformance suite:

```ts
import { runProviderConformanceSuite } from '@alvin0/ai-agent-sdk-testkit'
const report = await runProviderConformanceSuite(fixture)
```

## Describing a change

Describe the change from the consumer's point of view in the commit message. A
patch that removes or narrows a public export is not a patch.

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
- [Dependency policy](/en/14-project/dependency-policy)
