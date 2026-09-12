/**
 * Public surface and Copilot-independence of `protocol-openai-chat-completions`.
 *
 * Feature: github-copilot-provider — Requirements 10.1 and 10.8.
 *
 * Two separate claims are pinned here.
 *
 * The first is the SHAPE OF THE PUBLIC SURFACE: the protocol id is a stable
 * string, the marker pair (`kind`, `apiVersion`) is the one `provider-http`
 * looks for, `defaultDialect` is frozen and flat enough to survive the runtime's
 * config snapshot, and the package declares exactly one importable entry plus
 * `./package.json` — mapped at the barrel this test imports.
 *
 * The second is that the package DOES NOT KNOW COPILOT EXISTS. That claim is
 * only checkable by looking at every byte of `src/`, because it is a claim about
 * absence: no reachable code path can betray a leaked constant, so no
 * behavioural test can find one, and a reviewer reading a diff cannot see what a
 * later diff will add. The grep below is the enforcement — if it is weakened,
 * Requirement 10.8 stops being verified at all.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineWireProtocol } from '../../packages/provider-http/src/protocol/definition.ts'
import {
  OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID,
  openAiChatCompletionsProtocol,
  serializeChatCompletionsRequest,
  translateChatCompletionsStream,
} from '../../packages/protocol-openai-chat-completions/src/index.ts'
// `src/wire.ts` is re-exported from the barrel as TYPES ONLY, so the frozen
// default reaches consumers exclusively through `protocol.defaultDialect`. It is
// imported here from the module to assert those two are the same object rather
// than two copies that could drift.
import { DEFAULT_DIALECT } from '../../packages/protocol-openai-chat-completions/src/wire.ts'

const PACKAGE_DIR = fileURLToPath(
  new URL('../../packages/protocol-openai-chat-completions/', import.meta.url),
)
const SRC_DIR = join(PACKAGE_DIR, 'src')

interface PackageManifest {
  readonly name: string
  readonly exports: Readonly<Record<string, unknown>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
}

function manifest(): PackageManifest {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as PackageManifest
}

/** Every file under `src/`, recursively, as repo-relative-ish paths. */
function sourceFiles(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const absolute = join(dir, entry)
      const relative = prefix === '' ? entry : `${prefix}/${entry}`
      if (statSync(absolute).isDirectory()) walk(absolute, relative)
      else found.push(relative)
    }
  }
  walk(SRC_DIR, '')
  return found
}

// ---------------------------------------------------------------------------
// Public surface (Requirement 10.1)
// ---------------------------------------------------------------------------

describe('protocol-openai-chat-completions public surface', () => {
  it('exposes a stable protocol id, both as a constant and on the protocol', () => {
    expect(OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID).toBe('openai-chat-completions')
    expect(openAiChatCompletionsProtocol.id).toBe(OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID)
  })

  it('carries the marker pair `provider-http` dispatches on', () => {
    // The marker is how a wire protocol is recognised across a package boundary
    // without a shared nominal type. Changing either half is a breaking change
    // for every adapter, so both are pinned as literals.
    expect(openAiChatCompletionsProtocol.kind).toBe('http-wire-protocol')
    expect(openAiChatCompletionsProtocol.apiVersion).toBe(1)
  })

  it('exposes the four callable members an adapter needs', () => {
    expect(typeof openAiChatCompletionsProtocol.endpointPath).toBe('function')
    expect(typeof openAiChatCompletionsProtocol.serialize).toBe('function')
    expect(typeof openAiChatCompletionsProtocol.translate).toBe('function')
    expect(typeof serializeChatCompletionsRequest).toBe('function')
    expect(typeof translateChatCompletionsStream).toBe('function')
  })

  it('freezes the protocol object and its default dialect', () => {
    expect(Object.isFrozen(openAiChatCompletionsProtocol)).toBe(true)
    expect(Object.isFrozen(openAiChatCompletionsProtocol.defaultDialect)).toBe(true)
    expect(Object.isFrozen(DEFAULT_DIALECT)).toBe(true)
    expect(openAiChatCompletionsProtocol.defaultDialect).toBe(DEFAULT_DIALECT)
    // A shared mutable default would be a cross-provider side channel: one
    // adapter tweaking a knob would silently retune every other adapter built
    // on the same protocol object.
    expect(() => {
      ;(DEFAULT_DIALECT as { sampling: boolean }).sampling = false
    }).toThrow(TypeError)
    expect(DEFAULT_DIALECT.sampling).toBe(true)
  })

  it('keeps the default dialect flat and primitive-valued', () => {
    // `resolveDialect` merges shallowly and the runtime snapshots the dialect as
    // JSON, so a nested object here would be either half-merged or rejected.
    for (const [key, value] of Object.entries(DEFAULT_DIALECT)) {
      expect(['string', 'number', 'boolean'], `dialect.${key}`).toContain(typeof value)
    }
    expect(DEFAULT_DIALECT.path).toBe('/chat/completions')
  })

  it('defaults conservatively on the three knobs older gateways reject', () => {
    // Unsent field costs a feature; unknown field costs the whole request.
    expect(DEFAULT_DIALECT.parallelToolCalls).toBe(false)
    expect(DEFAULT_DIALECT.seed).toBe(false)
    expect(DEFAULT_DIALECT.reasoningEffort).toBe(false)
  })

  it('survives `defineWireProtocol` unchanged', () => {
    // The real consumer contract: `provider-http` re-stamps the definition,
    // snapshotting the dialect and capturing each method with its receiver. A
    // dialect too deep or a method relying on `this` fails here and nowhere else.
    const runtime = defineWireProtocol(openAiChatCompletionsProtocol)
    expect(runtime.id).toBe(OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID)
    expect(runtime.kind).toBe('http-wire-protocol')
    expect(runtime.apiVersion).toBe(1)
    expect(runtime.defaultDialect).toEqual({ ...DEFAULT_DIALECT })
    expect(runtime.endpointPath({} as never, DEFAULT_DIALECT)).toBe('/chat/completions')
  })

  it('declares exactly one importable entry, resolving to the barrel', async () => {
    const pkg = manifest()
    expect(pkg.name).toBe('@alvin0/ai-agent-sdk-protocol-openai-chat-completions')
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './package.json'])
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js',
    })
    // The built entry comes from `src/index.ts`; that the entry resolves and
    // carries the protocol is asserted against the source barrel, since `dist`
    // exists only after a build.
    const barrel = await import('../../packages/protocol-openai-chat-completions/src/index.ts')
    expect(barrel.openAiChatCompletionsProtocol).toBe(openAiChatCompletionsProtocol)
    expect(barrel.OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID).toBe(OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID)
  })

  it('depends on core alone', () => {
    const pkg = manifest()
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual(['@alvin0/ai-agent-sdk-core'])
    expect(pkg.dependencies ?? {}).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Copilot independence (Requirement 10.8)
// ---------------------------------------------------------------------------

describe('protocol-openai-chat-completions carries nothing Copilot-specific', () => {
  /**
   * Matched case-insensitively, because the leak this catches is a copy-paste
   * from the provider package and the casing of a pasted constant is not
   * something to bet the check on.
   */
  const FORBIDDEN = ['copilot', 'githubcopilot', 'Editor-Version', 'Editor-Plugin-Version'] as const

  it('reads a non-empty source tree, so the grep cannot pass vacuously', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(0)
    // Named explicitly: a renamed or relocated module must update this list
    // rather than silently drop out of the scan.
    expect(files).toEqual([
      'contract.ts',
      'errors.ts',
      'index.ts',
      'protocol.ts',
      'serialize.ts',
      'translate.ts',
      'wire.ts',
    ])
  })

  it('contains none of the Copilot identity strings in any file under src/', () => {
    const offences: string[] = []
    for (const file of sourceFiles()) {
      const text = readFileSync(join(SRC_DIR, file), 'utf8')
      const lines = text.split('\n')
      for (const needle of FORBIDDEN) {
        const lowered = needle.toLowerCase()
        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(lowered)) {
            offences.push(`src/${file}:${String(index + 1)} contains "${needle}": ${line.trim()}`)
          }
        })
      }
    }
    expect(offences, offences.join('\n')).toEqual([])
  })

  it('names no endpoint host or editor header in the default dialect', () => {
    // The positive half of the same requirement: base URL and headers arrive as
    // parameters, so the shipped dialect must carry a path and nothing more.
    const serialized = JSON.stringify(DEFAULT_DIALECT).toLowerCase()
    for (const needle of [...FORBIDDEN, 'https://', 'http://']) {
      expect(serialized, needle).not.toContain(needle.toLowerCase())
    }
    expect(openAiChatCompletionsProtocol.protocolHeaders).toBeUndefined()
  })
})
