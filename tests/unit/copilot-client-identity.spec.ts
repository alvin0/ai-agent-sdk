/**
 * Structural tests for the Copilot `Client_Identity_Constants`.
 *
 * Requirement 11 asks for three things that are easy to claim and easy to lose:
 * the constants are exported with descriptive names (11.1), each one is
 * overridable through a configuration option (11.2), and the module comment says
 * out loud that the defaults make the SDK present itself as an editor client and
 * that this is why they are named options rather than hidden constants (11.3).
 * The comment clause is only checkable by reading the source, so this file reads
 * the source.
 *
 * Requirement 2.1 pins the Copilot base URL; the request-URL half of it lands
 * with the adapter.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  COPILOT_BASE_URL,
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
  COPILOT_OAUTH_CLIENT_ID,
  COPILOT_OAUTH_SCOPE,
  DEFAULT_COPILOT_OAUTH_ISSUER,
  type CopilotEditorHeaders,
} from '../../packages/provider-copilot/src/index.ts'

const packageRoot = new URL('../../packages/provider-copilot/', import.meta.url)
const readSource = (name: string): string => readFileSync(new URL(`src/${name}`, packageRoot), 'utf8')

describe('Copilot client identity constants', () => {
  it('exports the three identity values as non-empty strings', () => {
    for (const value of [COPILOT_OAUTH_CLIENT_ID, COPILOT_EDITOR_VERSION, COPILOT_EDITOR_PLUGIN_VERSION]) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('ships no placeholder in place of a value', () => {
    for (const value of [COPILOT_OAUTH_CLIENT_ID, COPILOT_EDITOR_VERSION, COPILOT_EDITOR_PLUGIN_VERSION]) {
      expect(value).not.toMatch(/[<>]|TODO|placeholder|xxx/i)
    }
  })

  it('pins the OAuth issuer, scope, and Copilot base URL to https origins', () => {
    expect(DEFAULT_COPILOT_OAUTH_ISSUER).toBe('https://github.com')
    expect(COPILOT_BASE_URL).toBe('https://api.githubcopilot.com')
    expect(COPILOT_OAUTH_SCOPE).toBe('read:user')
    for (const origin of [DEFAULT_COPILOT_OAUTH_ISSUER, COPILOT_BASE_URL]) {
      expect(new URL(origin).protocol).toBe('https:')
    }
  })

  it('shapes the editor headers as two independent optional overrides', () => {
    const both: CopilotEditorHeaders = { editorVersion: 'a/1', editorPluginVersion: 'b/2' }
    const onlyOne: CopilotEditorHeaders = { editorVersion: 'a/1' }
    const neither: CopilotEditorHeaders = {}
    expect(both.editorPluginVersion).toBe('b/2')
    expect(onlyOne.editorPluginVersion).toBeUndefined()
    expect(Object.keys(neither)).toHaveLength(0)
  })

  it('resolves each header from the override first and the exported default second', () => {
    // The resolution rule the adapter has to implement: an absent override keeps
    // the exported default rather than dropping the header, because a dropped
    // editor header is an HTTP 400 rather than a lenient request.
    const resolve = (headers: CopilotEditorHeaders = {}): Record<string, string> => ({
      'editor-version': headers.editorVersion ?? COPILOT_EDITOR_VERSION,
      'editor-plugin-version': headers.editorPluginVersion ?? COPILOT_EDITOR_PLUGIN_VERSION,
    })
    expect(resolve()).toEqual({
      'editor-version': COPILOT_EDITOR_VERSION,
      'editor-plugin-version': COPILOT_EDITOR_PLUGIN_VERSION,
    })
    expect(resolve({ editorVersion: 'neovim/0.11.0' })).toEqual({
      'editor-version': 'neovim/0.11.0',
      'editor-plugin-version': COPILOT_EDITOR_PLUGIN_VERSION,
    })
  })

  it('states the editor-client identity and the named-option rationale in both module comments', () => {
    for (const name of ['oauth.ts', 'adapter.ts']) {
      const source = readSource(name)
      // Collapse the comment framing so a clause wrapped across two lines still
      // reads as one phrase.
      const header = source.slice(0, source.indexOf('*/')).replace(/^\s*\*/gm, ' ').replace(/\s+/g, ' ')
      expect(header).toMatch(/editor client/i)
      expect(header).toMatch(/named option/i)
      expect(header).toMatch(/hidden/i)
    }
  })

  // Each of the three identity values is either still outstanding or confirmed
  // against a live account, and the source has to say WHICH — that is the point of
  // these two tests. Originally one test counting three outstanding reminders; the
  // 2026-09-10 live run resolved two of the three, so the count split in two
  // rather than shrinking. The intent is unchanged and now cuts both ways: a
  // reminder cannot be dropped silently, and it cannot be dropped in favour of a
  // bare "confirmed" with no date either.

  it('still records the outstanding live confirmation for the OAuth client id', () => {
    // One value, one reminder, and it lives with the constant it is about.
    const oauth = readSource('oauth.ts')
    expect(oauth.match(/TODO\(copilot-identity\)/g)).toHaveLength(1)
    expect(oauth.match(/UNVERIFIED/g)).toHaveLength(1)
  })

  it('records a dated live confirmation for each editor header instead of a reminder', () => {
    // The two headers travel on the same request, so one live run settles the
    // pair — hence exactly two confirmations, each carrying the date it was made.
    const adapter = readSource('adapter.ts')
    expect(adapter.match(/TODO\(copilot-identity\)/g)).toBeNull()
    expect(adapter.match(/UNVERIFIED/g)).toBeNull()
    expect(adapter.match(/✔ CONFIRMED[\s\S]{0,240}?\d{4}-\d{2}-\d{2}/g)).toHaveLength(2)
  })
})
