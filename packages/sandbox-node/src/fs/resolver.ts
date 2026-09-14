/** Node filesystem facts for the Universal contract's injected resolver. */

import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { PathResolver } from '@alvin0/ai-agent-sdk-sandbox'
import { normalizePath } from '@alvin0/ai-agent-sdk-sandbox'

/** A resolver backed by the real filesystem. */
export function nodePathResolver(): PathResolver {
  return Object.freeze({
    async realpath(path: string): Promise<string> {
      try { return normalizePath(await realpath(path)) }
      catch { return normalizePath(path) }
    },
    async exists(path: string): Promise<boolean> {
      try { await stat(path); return true }
      catch { return false }
    },
  })
}

/**
 * Temp roots `workspace-write` grants in addition to the workspace.
 *
 * Reported as the host temp directory so the in-process fence and the kernel
 * profiles agree on the same answer. The bwrap backend substitutes an ephemeral
 * `/tmp` for it, which is narrower, never wider.
 */
export function defaultTempRoots(): readonly string[] {
  return Object.freeze([normalizePath(tmpdir())])
}

/** Whether a path exists and is a directory; drives mask selection. */
export async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() }
  catch { return false }
}
