/**
 * Architecture gate for the Copilot provider.
 *
 * Feature: github-copilot-provider — Requirements 6.1, 18.3, 18.4, 18.6.
 *
 * Three separate claims live here, and none of them is about Copilot behaviour:
 *
 *  - **Requirements 1.5, 18.4 — the existing packages did not move.**
 *    `packages/core`, `packages/provider-http`, the three protocol packages that
 *    predate this feature, and the two embedding providers that predate it
 *    (`provider-openai`, `provider-gemini`) keep the public surface they had.
 *    The two providers are here for Requirement 1.5 specifically: Copilot ADDS an
 *    embedding provider, so neither existing one may gain, lose or reshape a
 *    single published name on its account. This is the condition DD-1 and
 *    DD-3 were decided under: both wanted a channel through `provider-http`, and
 *    both were solved INSIDE `provider-copilot` instead, precisely so this file
 *    can hold. The check is a snapshot of each entry point's emitted
 *    declarations — the export list AND the declaration text — because a type
 *    that gains a field changes the surface just as much as an export that
 *    appears.
 *  - **Requirement 6.1 — `authStore` is injected, never defaulted.** A Universal
 *    package has no path, no filesystem and no environment, so there is no
 *    default it could invent. Building a route without one has to FAIL, and fail
 *    while the runtime is being composed rather than on the first generation.
 *  - **Requirements 18.3, 18.6 — the dependency set stays inside the workspace.**
 *    `pnpm lint` is the enforcement (`check-package-graph`,
 *    `check-dependency-cruiser`, `check-runtime-boundaries`); what is asserted
 *    here is the manifest data those tools read, so a manifest edit that would
 *    make them vacuous is visible in a test diff too.
 *
 * The "does not touch the filesystem" constraint needs no rule of its own:
 * `scripts/check-runtime-boundaries.mts` already forbids every Node builtin and
 * the four Node globals in any package declaring `runtime: 'universal'`, which is
 * strictly stronger. This file asserts the declaration that arms it.
 *
 * ## Regenerating the surface snapshot
 *
 * The snapshot is deliberately not self-updating. When a change to one of the
 * seven packages is intended — by another feature, since THIS feature may not
 * change them — rebuild (`pnpm build`) and run:
 *
 * ```
 * UPDATE_PACKAGE_SURFACE=1 npx vitest run tests/unit/copilot-architecture.spec.ts
 * ```
 *
 * and commit the fixture together with the change that caused it, so the diff
 * shows what moved.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { copilotAdapter, copilotPlugin } from '../../packages/provider-copilot/src/adapter.ts'
import { memoryCopilotCredentialStore } from '../../packages/provider-copilot/src/auth.ts'

const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURE = join(WORKSPACE_ROOT, 'tests', 'fixtures', 'public-api', 'untouched-packages.json')

/**
 * The packages this feature may not change, with the export subpaths each one
 * publishes. `./package.json` is excluded: it is not a code entry point.
 */
const UNTOUCHED_PACKAGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  core: ['.', './agent', './memory', './provider', './skills', './tools', './observability'],
  'provider-http': ['.'],
  'protocol-responses': ['.'],
  'protocol-anthropic-messages': ['.'],
  'protocol-gemini-interactions': ['.'],
  // Requirement 1.5: the two providers that already ship an embedding adapter.
  // Copilot adds a third; it replaces neither, so both surfaces are frozen here.
  'provider-openai': ['.'],
  'provider-gemini': ['.'],
})

interface EntrySurface {
  readonly exports: readonly string[]
  readonly declarationSha256: string
}

type PackageSurface = Readonly<Record<string, Readonly<Record<string, EntrySurface>>>>

interface SurfaceSnapshot {
  readonly schemaVersion: number
  readonly packages: PackageSurface
}

interface PackageManifest {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly exports?: Readonly<Record<string, { readonly types?: string }>>
  readonly bin?: Readonly<Record<string, string>>
  readonly aiAgentSdk?: { readonly runtime?: string }
}

function manifestOf(directory: string): PackageManifest {
  return JSON.parse(
    readFileSync(join(WORKSPACE_ROOT, 'packages', directory, 'package.json'), 'utf8'),
  ) as PackageManifest
}

/** The emitted declaration file backing one export subpath. */
function declarationPath(directory: string, subpath: string): string {
  const entry = manifestOf(directory).exports?.[subpath]
  const types = entry?.types
  if (types === undefined) throw new Error(`packages/${directory} publishes no types for ${subpath}`)
  return join(WORKSPACE_ROOT, 'packages', directory, types.replace(/^\.\//, ''))
}

/**
 * The names an entry point publishes, read off the emitted declarations.
 *
 * The bundler ends every declaration file with one `export { … }` clause, so the
 * last clause in the file IS the surface — including the type-only names, which a
 * runtime `import()` cannot see and which are most of what DD-1 and DD-3 were
 * about.
 */
function exportedNames(declarations: string): readonly string[] {
  const clause = [...declarations.matchAll(/export\s*\{([^}]*)\}/g)].at(-1)
  if (clause?.[1] === undefined) throw new Error('declaration file carries no export clause')
  return clause[1]
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => entry.replace(/^type\s+/, ''))
    // `X as Y` publishes `Y`; the local name is private.
    .map(entry => (entry.split(/\s+as\s+/).at(-1) ?? entry).trim())
    .sort()
}

/**
 * The declaration text, comments and whitespace removed.
 *
 * Hashing this instead of the raw file keeps a reworded doc comment from reading
 * as a surface change, while a changed signature, a new field on a published type
 * or a dropped one all still move the hash.
 */
function declarationDigest(declarations: string): string {
  const withoutComments = declarations
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
  return createHash('sha256').update(withoutComments.replace(/\s+/g, ' ').trim()).digest('hex')
}

function currentSurface(): PackageSurface {
  const packages: Record<string, Record<string, EntrySurface>> = {}
  for (const [directory, subpaths] of Object.entries(UNTOUCHED_PACKAGES)) {
    const entries: Record<string, EntrySurface> = {}
    for (const subpath of subpaths) {
      const path = declarationPath(directory, subpath)
      if (!existsSync(path)) {
        throw new Error(
          `${path} is missing; run \`pnpm build\` before the surface snapshot check`,
        )
      }
      const declarations = readFileSync(path, 'utf8')
      entries[subpath] = {
        exports: exportedNames(declarations),
        declarationSha256: declarationDigest(declarations),
      }
    }
    packages[manifestOf(directory).name] = entries
  }
  return packages
}

const observed = currentSurface()

if (process.env.UPDATE_PACKAGE_SURFACE === '1') {
  writeFileSync(
    FIXTURE,
    `${JSON.stringify({ schemaVersion: 1, packages: observed }, null, 2)}\n`,
  )
}

const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as SurfaceSnapshot

// ---------------------------------------------------------------------------
// Requirement 18.4
// ---------------------------------------------------------------------------

describe('the existing packages keep the public surface they had (Requirements 1.5, 18.4)', () => {
  it('covers exactly the seven packages the requirements name', () => {
    expect(recorded.schemaVersion).toBe(1)
    expect(Object.keys(recorded.packages).sort()).toEqual(Object.keys(observed).sort())
    // Not an empty snapshot passing vacuously: `core` alone publishes hundreds of
    // names across seven entry points.
    const entries = Object.values(recorded.packages).flatMap(pkg => Object.values(pkg))
    expect(entries.length).toBe(13)
    expect(entries.reduce((total, entry) => total + entry.exports.length, 0))
      .toBeGreaterThan(200)
  })

  for (const [name, entries] of Object.entries(UNTOUCHED_PACKAGES).map(
    ([directory, subpaths]) => [manifestOf(directory).name, subpaths] as const,
  )) {
    for (const subpath of entries) {
      it(`publishes an unchanged surface for ${name} ${subpath}`, () => {
        const before = recorded.packages[name]?.[subpath]
        const after = observed[name]?.[subpath]
        expect(before, `${name} ${subpath} is missing from the snapshot`).toBeDefined()
        // Names first: the failure message then lists what appeared or vanished,
        // rather than only reporting that a hash moved.
        expect(after?.exports).toEqual(before?.exports)
        expect(
          after?.declarationSha256,
          `${name} ${subpath} declarations changed shape; see the regeneration note `
          + 'at the top of this file',
        ).toBe(before?.declarationSha256)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Requirement 6.1
// ---------------------------------------------------------------------------

describe('a Copilot route cannot be built without an injected store (Requirement 6.1)', () => {
  /** Each shape of "no usable store", including the one that is simply absent. */
  const rejected: readonly (readonly [string, unknown])[] = [
    ['absent', undefined],
    ['null', null],
    ['a string path, which this package may not resolve', '.providers/.copilot/auth.json'],
    ['an object with no store methods', {}],
    ['a store missing `read`', { location: '<memory>', write: () => undefined }],
    ['a CAS marker with no methods', { kind: 'credential-store', apiVersion: 1 }],
  ]

  for (const [label, authStore] of rejected) {
    it(`refuses to build an adapter when \`authStore\` is ${label}`, () => {
      expect(() => copilotAdapter({ authStore } as never)).toThrowError(
        /credential store is invalid/i,
      )
      // The code, not just the message: callers route on it.
      try {
        copilotAdapter({ authStore } as never)
        expect.unreachable('copilotAdapter accepted an unusable authStore')
      } catch (error) {
        expect((error as { readonly code?: unknown }).code).toBe('CREDENTIAL_STORE_INVALID')
      }
    })

    if (label === 'a CAS marker with no methods') continue
    it(`refuses to build a plugin when \`authStore\` is ${label}`, () => {
      // The plugin demands the compare-and-swap variant and checks the MARKER at
      // construction, so a store of the wrong shape is reported while the runtime
      // is being composed rather than on the first generation.
      expect(() => copilotPlugin({ authStore } as never)).toThrow(TypeError)
    })
  }

  it('lets a marker-bearing but unusable store through construction, and fails the capture', () => {
    // The marker check reads a data property and invokes nothing, which is the
    // point: telling the variants apart must not run the caller's code. So a store
    // that carries the marker and nothing else is rejected by the capture — the
    // step that actually needs the methods — with the store-invalid code.
    const authStore = { kind: 'credential-store', apiVersion: 1 } as never
    expect(() => copilotPlugin({ authStore })).not.toThrow()
    expect(() => copilotAdapter({ authStore })).toThrowError(/credential store is invalid/i)
  })

  it('accepts the injected compare-and-swap store, so the refusals are not blanket', () => {
    const authStore = memoryCopilotCredentialStore()
    expect(() => copilotAdapter({ authStore, models: [] })).not.toThrow()
    expect(() => copilotPlugin({ authStore, models: [] })).not.toThrow()
  })

  it('reads no path, environment or filesystem from the option itself', () => {
    // The negative half of the same requirement: there is no default location to
    // fall back to, so the package cannot name one.
    const adapterSource = readFileSync(
      join(WORKSPACE_ROOT, 'packages', 'provider-copilot', 'src', 'adapter.ts'),
      'utf8',
    )
    expect(adapterSource).not.toMatch(/authStore\s*(?:\?\?|\|\|)\s*[a-zA-Z{'"]/)
  })
})

// ---------------------------------------------------------------------------
// Requirements 18.3, 18.6
// ---------------------------------------------------------------------------

describe('the two new packages stay inside the workspace (Requirements 18.3, 18.6)', () => {
  const introduced = ['provider-copilot', 'protocol-openai-chat-completions'] as const

  for (const directory of introduced) {
    it(`declares \`runtime: 'universal'\` for ${directory}, which arms the boundary check`, () => {
      // This one field is what makes `check-runtime-boundaries.mts` forbid every
      // Node builtin and the four Node globals in the package. Dropping it would
      // silently retire the constraint, so it is asserted rather than assumed.
      expect(manifestOf(directory).aiAgentSdk?.runtime).toBe('universal')
    })

    it(`limits every runtime dependency of ${directory} to a workspace package`, () => {
      const manifest = manifestOf(directory)
      const runtimeDependencies = [
        ...Object.entries(manifest.dependencies ?? {}),
        ...Object.entries(manifest.optionalDependencies ?? {}),
        ...Object.entries(manifest.peerDependencies ?? {}),
      ]
      for (const [dependency, range] of runtimeDependencies) {
        expect(dependency, `${directory} depends on ${dependency}`)
          .toMatch(/^@alvin0\/ai-agent-sdk-/)
        expect(range, `${directory} → ${dependency}`).toMatch(/^workspace:/)
      }
      expect(runtimeDependencies.length).toBeGreaterThan(0)
    })
  }

  it('keeps `provider-copilot` out of the protocol package, so the edge runs one way', () => {
    // Requirement 18.5, and the structural reason `no-circular` holds without a
    // convention: the protocol package knows nothing about the provider that uses
    // it.
    const protocol = manifestOf('protocol-openai-chat-completions')
    const declared = [
      ...Object.keys(protocol.dependencies ?? {}),
      ...Object.keys(protocol.optionalDependencies ?? {}),
      ...Object.keys(protocol.peerDependencies ?? {}),
    ]
    expect(declared).not.toContain('@alvin0/ai-agent-sdk-provider-copilot')
    for (const dependency of declared) {
      expect([
        '@alvin0/ai-agent-sdk-core',
        '@alvin0/ai-agent-sdk-provider-http',
      ]).toContain(dependency)
    }
  })

  it('registers both packages in the workspace build, so a stale `dist` cannot ship', () => {
    const root = JSON.parse(
      readFileSync(join(WORKSPACE_ROOT, 'package.json'), 'utf8'),
    ) as { readonly scripts?: Readonly<Record<string, string>> }
    const build = root.scripts?.build ?? ''
    for (const directory of introduced) {
      expect(build, directory).toContain(`@alvin0/ai-agent-sdk-${directory} build`)
    }
  })
})

// ---------------------------------------------------------------------------
// Requirement 18.7
// ---------------------------------------------------------------------------

/**
 * The bundle names `tsdown.config.ts` asks for, read off the `entry` map.
 *
 * The config is read as text rather than imported: importing it evaluates
 * `libraryBuild`, which resolves plugins and tsconfig, and the only thing needed
 * here is the set of keys the author wrote.
 */
function tsdownEntries(directory: string): readonly string[] {
  const source = readFileSync(
    join(WORKSPACE_ROOT, 'packages', directory, 'tsdown.config.ts'),
    'utf8',
  )
  const block = /entry:\s*\{([^}]*)\}/.exec(source)
  if (block?.[1] === undefined) throw new Error(`packages/${directory} declares no entry map`)
  return [...block[1].matchAll(/(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)]
    .map(match => match[1] ?? match[2] ?? match[3] ?? '')
    .filter(name => name.length > 0)
    .sort()
}

/**
 * Reconciles the two lists that have to agree for a package to be installable.
 *
 * They drift in both directions and neither direction is caught by a build:
 * an `exports` subpath with no matching entry publishes a path the bundler never
 * emitted, so the import fails only once someone installs the tarball; an entry
 * with no `exports` subpath ships dead bytes — unless it backs a `bin` script,
 * which is reachable by path and deliberately absent from `exports`.
 */
describe('`package.json#exports` and `tsdown.config.ts#entry` agree (Requirement 18.7)', () => {
  const packages = ['provider-copilot', 'protocol-openai-chat-completions', 'auth-node'] as const

  for (const directory of packages) {
    it(`emits a bundle for every export subpath of ${directory}`, () => {
      const manifest = manifestOf(directory)
      const entries = tsdownEntries(directory)
      const subpaths = Object.keys(manifest.exports ?? {}).filter(key => key !== './package.json')
      expect(subpaths.length).toBeGreaterThan(0)
      for (const subpath of subpaths) {
        // `.` is emitted as `index`; `./env` as `env`.
        const expected = subpath === '.' ? 'index' : subpath.replace(/^\.\//, '')
        expect(entries, `${directory} exports ${subpath} with no matching entry`)
          .toContain(expected)
        // And the declaration the subpath points at exists on disk, so the
        // agreement is with a real build rather than with a naming convention.
        expect(
          existsSync(declarationPath(directory, subpath)),
          `${directory} ${subpath} points at a declaration that was not emitted`,
        ).toBe(true)
      }
    })

    it(`exports or bins every bundle ${directory} emits`, () => {
      const manifest = manifestOf(directory)
      const exported = new Set(
        Object.keys(manifest.exports ?? {})
          .filter(key => key !== './package.json')
          .map(key => (key === '.' ? 'index' : key.replace(/^\.\//, ''))),
      )
      // A bin script imports its bundle by path, so the entry is reachable
      // without an `exports` subpath. Match on the bundle name appearing in the
      // script rather than trusting a naming rule.
      const binSources = Object.values(manifest.bin ?? {}).map(path =>
        readFileSync(join(WORKSPACE_ROOT, 'packages', directory, path.replace(/^\.\//, '')), 'utf8'),
      )
      for (const entry of tsdownEntries(directory)) {
        if (exported.has(entry)) continue
        expect(
          binSources.some(source => source.includes(`/${entry}.`)),
          `${directory} emits \`${entry}\` that no export subpath and no bin script reaches`,
        ).toBe(true)
      }
    })
  }

  it('declares no `./embedding` subpath yet, and declares none it cannot emit', () => {
    // Requirement 1.6 is NOT satisfied here, and this test records why rather
    // than pretending otherwise: `provider-copilot` has no `src/embedding.ts`,
    // `packages/core` has no `embedding` entry point, and so there is no
    // `./embedding` subpath to resolve. What IS enforced is the weaker,
    // currently checkable claim — the manifest does not advertise a subpath the
    // build cannot produce. When the embedding entry lands, this expectation
    // flips and the two reconciliation tests above cover it with no change.
    const manifest = manifestOf('provider-copilot')
    expect(Object.keys(manifest.exports ?? {})).not.toContain('./embedding')
    expect(tsdownEntries('provider-copilot')).not.toContain('embedding')
  })
})
