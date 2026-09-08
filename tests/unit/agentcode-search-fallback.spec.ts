import { mkdtempSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fallbackSearch } from '../../test-human/agentcode/tools/search.ts'
import { SEARCH_EXCLUDES } from '../../test-human/agentcode/tools/types.ts'

const signal = new AbortController().signal

async function workspace(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'agentcode-search-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(root, 'src', 'store.ts'), 'export const count = 2\nexport const other = 3')
  await writeFile(join(root, 'src', 'view.tsx'), 'const count = 2')
  await writeFile(join(root, 'package-lock.json'), 'https://registry.example/package')
  await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'const count = 2')
  return root
}

function search(root: string, pattern: string, extra: Record<string, unknown> = {}) {
  return fallbackSearch({
    root, target: root, pattern, excludes: SEARCH_EXCLUDES, maxMatches: 50, signal, ...extra,
  })
}

describe('agentcode search fallback', () => {
  // `rg` is not part of Node. Without this path a machine that simply has no
  // ripgrep installed turned every search into `spawn rg ENOENT` — a message
  // the model cannot act on, for work Node can do itself.
  it('reports matches in ripgrep output shape', async () => {
    const root = await workspace()
    const matches = await search(root, 'count = 2')

    expect(matches).toEqual(expect.arrayContaining([expect.stringContaining('src/store.ts:1:14:')]))
    // Path, line, column, then the line itself — what portableGrepMatch parses.
    for (const match of matches) expect(match).toMatch(/^[^:]+:\d+:\d+:/)
  })

  it('applies the same exclusions ripgrep is given', async () => {
    const root = await workspace()

    expect(await search(root, 'https://')).toEqual([])
    expect(await search(root, 'count = 2')).not.toEqual(
      expect.arrayContaining([expect.stringContaining('node_modules')]),
    )
  })

  it('filters by an inclusion glob', async () => {
    const root = await workspace()
    const matches = await search(root, 'count = 2', { glob: '**/*.tsx' })

    expect(matches).toHaveLength(1)
    expect(matches[0]).toContain('src/view.tsx')
  })

  it('stops at the match ceiling', async () => {
    const root = await workspace()
    await writeFile(
      join(root, 'src', 'many.ts'),
      Array.from({ length: 40 }, (_, index) => `const needle${String(index)} = 1`).join('\n'),
    )

    expect(await search(root, 'needle', { maxMatches: 5 })).toHaveLength(5)
  })

  it('skips a binary file rather than printing its bytes', async () => {
    const root = await workspace()
    await writeFile(join(root, 'src', 'blob.bin'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x00, 0x6c]))

    expect(await search(root, 'need')).toEqual([])
  })

  it('never follows a symlink out of the workspace', async () => {
    const root = await workspace()
    const outside = mkdtempSync(join(tmpdir(), 'agentcode-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'TOP_SECRET_NEEDLE')
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    expect(await search(root, 'TOP_SECRET_NEEDLE')).toEqual([])
  })

  it('searches literally for a pattern JavaScript cannot compile', async () => {
    const root = await workspace()
    await writeFile(join(root, 'src', 'odd.ts'), 'const value = a[b')

    // rg accepts syntax JavaScript rejects. Finding the text beats lecturing
    // the model about regex dialects.
    const matches = await search(root, 'a[b')
    expect(matches[0]).toContain('src/odd.ts')
  })
})
