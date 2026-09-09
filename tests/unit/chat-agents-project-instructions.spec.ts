import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const { listProjectInstructions } =
  await import('../../samples/chat-agents/backend/src/instructions.ts')

/** A workspace with the given files, contents keyed by relative path. */
async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'instructions-'))
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, content, 'utf8')
  }
  return root
}

/**
 * What the settings pane can say about a project's `AGENTS.md`.
 *
 * The SDK delivers these files as an always-on context section, which is silent
 * by design: it owns one node on the model surface and rewrites it when the
 * files change. Silent is right for the model and wrong for the user — a
 * convention file being read invisibly looks exactly like one being ignored.
 */
describe('the instruction files a project has', () => {
  it('finds the workspace file', async () => {
    const root = await workspace({ 'AGENTS.md': '# House rules\nUse tabs.\n' })
    const found = await listProjectInstructions(root)
    expect(found.files.map(file => file.path)).toEqual(['AGENTS.md'])
    expect(found.files[0]?.firstLine).toBe('# House rules')
    expect(found.projectRoot).toBe(root)
  })

  it('says nothing is there rather than guessing', async () => {
    const found = await listProjectInstructions(await workspace({ 'README.md': 'hi' }))
    expect(found.files).toEqual([])
    // The pane needs the candidate names to tell the user what to create.
    expect(found.fileNames).toContain('AGENTS.md')
  })

  it('takes the override and leaves the plain file, as the runtime does', async () => {
    // `perDirectory: 'first'` is the runtime's default. A pane that listed both
    // would show a file that is NOT in the prompt.
    const root = await workspace({
      'AGENTS.md': 'plain',
      'AGENTS.override.md': 'override',
    })
    const found = await listProjectInstructions(root)
    expect(found.files.map(file => file.path)).toEqual(['AGENTS.override.md'])
  })

  it('stops at the workspace root by default', async () => {
    // The workspace root is the boundary the tools refuse to cross. Walking up
    // to an enclosing checkout would put a file the agent can never read into
    // every prompt — and, in this sample, a file from another project.
    const outer = await workspace({
      'AGENTS.md': 'outer rules',
      '.git/HEAD': 'ref: refs/heads/main\n',
      'inner/AGENTS.md': 'inner rules',
    })
    const found = await listProjectInstructions(join(outer, 'inner'))
    expect(found.files.map(file => file.firstLine)).toEqual(['inner rules'])
  })

  it('walks up to the checkout when the host opts in', async () => {
    const outer = await workspace({
      'AGENTS.md': 'outer rules',
      '.git/HEAD': 'ref: refs/heads/main\n',
      'inner/AGENTS.md': 'inner rules',
    })
    const found = await listProjectInstructions(join(outer, 'inner'), { walkUp: true })
    // Broad-to-specific: the enclosing file first, so the nearer one can
    // override it — the order the model is shown them in.
    expect(found.files.map(file => file.firstLine)).toEqual(['outer rules', 'inner rules'])
    expect(found.files.map(file => file.path)).toEqual(['AGENTS.md', 'inner/AGENTS.md'])
  })

  it('reads the user’s own global file first, when the host names one', async () => {
    const root = await workspace({ 'AGENTS.md': 'project rules' })
    const home = await workspace({ 'global.md': 'personal rules' })
    const found = await listProjectInstructions(root, { globalFile: join(home, 'global.md') })
    expect(found.files.map(file => file.firstLine)).toEqual(['personal rules', 'project rules'])
    expect(found.files[0]?.global).toBe(true)
  })

  it('ignores a global file that is not there', async () => {
    // The env var can name a path the user has not created yet. That is not an
    // error, and a settings pane that crashed on it would be one.
    const root = await workspace({ 'AGENTS.md': 'project rules' })
    const found = await listProjectInstructions(root, { globalFile: join(root, 'missing.md') })
    expect(found.files.map(file => file.path)).toEqual(['AGENTS.md'])
  })

  it('ignores a directory that happens to be named AGENTS.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'instructions-'))
    await mkdir(join(root, 'AGENTS.md'))
    expect((await listProjectInstructions(root)).files).toEqual([])
  })
})
