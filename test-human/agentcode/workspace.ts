/** Filesystem boundary shared by every agentcode host tool. */

import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function resolveAgentCodePath(root: string, requested: string): string {
  if (requested.trim().length === 0) throw new Error('path must be a non-empty string')
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, requested)
  assertContained(absoluteRoot, target, requested)
  return target
}

export async function resolveExistingAgentCodePath(root: string, requested: string): Promise<string> {
  const absoluteRoot = await ensureAgentCodeWorkspace(root)
  const target = resolveAgentCodePath(absoluteRoot, requested)
  const canonical = await realpath(target)
  assertContained(absoluteRoot, canonical, requested)
  return canonical
}

export async function resolveWritableAgentCodePath(root: string, requested: string): Promise<string> {
  const absoluteRoot = await ensureAgentCodeWorkspace(root)
  const target = resolveAgentCodePath(absoluteRoot, requested)
  const existing = await closestExisting(target)
  const canonicalParent = await realpath(existing)
  assertContained(absoluteRoot, canonicalParent, requested)
  await mkdir(dirname(target), { recursive: true })
  const canonicalDirectory = await realpath(dirname(target))
  assertContained(absoluteRoot, canonicalDirectory, requested)
  try {
    const canonicalTarget = await realpath(target)
    assertContained(absoluteRoot, canonicalTarget, requested)
    return canonicalTarget
  } catch (error: unknown) {
    if (isMissing(error)) return target
    throw error
  }
}

export async function ensureAgentCodeWorkspace(root: string): Promise<string> {
  const absolute = resolve(root)
  await mkdir(absolute, { recursive: true })
  return realpath(absolute)
}

function assertContained(root: string, target: string, requested: string): void {
  const fromRoot = relative(root, target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`path escapes agentcode workspace: ${requested}`)
  }
}

async function closestExisting(target: string): Promise<string> {
  let current = target
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error: unknown) {
      if (!isMissing(error)) throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}
