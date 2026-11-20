import { expect, it } from 'vitest'
import { renderInstructions } from '@alvin0/ai-agent-sdk-instructions-node'
import { resolveInstructionsConfig } from '../../packages/instructions-node/src/config.ts'
import { readInstructionFile } from '../../packages/instructions-node/src/discovery.ts'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('accounts for omission notices within the instruction byte ceiling', () => {
  const config = resolveInstructionsConfig({ intro: 'Intro.', maxBytes: 100 }, '/workspace')
  const files = ['first.md', 'second.md'].map((name, index) => ({
    absolutePath: `/workspace/${name}`, displayPath: name,
    content: String(index).repeat(50), mtimeMs: 0, size: 50,
  }))
  const result = renderInstructions(files, config)
  expect(result?.included).toHaveLength(1)
  expect(result?.omitted).toHaveLength(1)
  expect(Buffer.byteLength(result?.text ?? '')).toBeLessThanOrEqual(config.maxBytes)
})

it('uses a brief omission notice when file names exceed its remaining budget', () => {
  const config = resolveInstructionsConfig({ intro: 'Intro.', maxBytes: 130 }, '/workspace')
  const files = ['first.md', 'a-very-long-subdirectory/second.md'].map((name, index) => ({
    absolutePath: `/workspace/${name}`, displayPath: name,
    content: String(index).repeat(50), mtimeMs: 0, size: 50,
  }))
  const result = renderInstructions(files, config)
  expect(result?.text).toContain('Omitted 1 instruction file.')
  expect(Buffer.byteLength(result?.text ?? '')).toBeLessThanOrEqual(config.maxBytes)
})

it('skips a file that grew beyond its byte ceiling after metadata collection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'instruction-growth-'))
  try {
    const path = join(directory, 'AGENTS.md')
    await writeFile(path, 'x'.repeat(4096))
    const config = resolveInstructionsConfig({ maxBytes: 128, maxFileBytes: 128 }, directory)
    await expect(readInstructionFile(path, directory, config, { size: 16, mtimeMs: 0 }))
      .resolves.toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('loads a small file with a ceiling larger than the maximum buffer allocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'instruction-large-budget-'))
  try {
    const path = join(directory, 'AGENTS.md')
    const content = 'Use the workspace conventions.'
    await writeFile(path, content)
    const config = resolveInstructionsConfig({
      maxBytes: Number.MAX_SAFE_INTEGER, maxFileBytes: Number.MAX_SAFE_INTEGER,
    }, directory)
    await expect(readInstructionFile(path, directory, config, { size: content.length, mtimeMs: 0 }))
      .resolves.toMatchObject({ content })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('loads a growing file at the ceiling across chunk and UTF-8 boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'instruction-chunks-'))
  try {
    const path = join(directory, 'AGENTS.md')
    const content = `${'x'.repeat(65_535)}€${'y'.repeat(65_535)}`
    await writeFile(path, content)
    const ceiling = Buffer.byteLength(content)
    const config = resolveInstructionsConfig({ maxBytes: ceiling, maxFileBytes: ceiling }, directory)
    await expect(readInstructionFile(path, directory, config, { size: 1, mtimeMs: 0 }))
      .resolves.toMatchObject({ content })
    await writeFile(path, `${content}z`)
    await expect(readInstructionFile(path, directory, config, { size: 1, mtimeMs: 0 }))
      .resolves.toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
