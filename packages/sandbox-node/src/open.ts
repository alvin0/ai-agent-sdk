/**
 * Opening a confined path without losing the check on the way.
 *
 * `assertWritable(path)` answers a question about a path, and the answer is
 * stale the instant it returns: between the check and the write, another
 * process can replace the last component with a symlink pointing anywhere.
 * Measured, that is not a theoretical window — twenty thousand rounds against a
 * process swapping the link landed writes outside the workspace.
 *
 * The check and the open therefore have to be one step whose result is a
 * descriptor rather than a verdict. `O_NOFOLLOW` makes the kernel refuse the
 * open if the final component became a symlink, so the descriptor that comes
 * back is bound to the inode that was checked.
 */

import { constants, type Mode } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SandboxDeniedError, type FsFence, type PathResolver } from '@alvin0/ai-agent-sdk-sandbox'
import { nodePathResolver } from './fs/resolver.ts'

/** How a confined write should be opened. */
export interface ConfinedOpenOptions {
  /** Truncate an existing file rather than appending. Default `true`. */
  readonly truncate?: boolean
  /** File mode for a newly created file. */
  readonly mode?: Mode
  /** Filesystem facts; defaults to the real filesystem. */
  readonly resolver?: PathResolver
}

/**
 * Open a path for writing only if the fence permits it, refusing to follow a
 * symlink placed on the final component after the check.
 *
 * @param fence - the fence for this call's policy.
 * @param path - the file to open.
 * @throws SandboxDeniedError when the fence refuses the path, or when the final
 *   component turned into a symlink between the check and the open — which is
 *   what an attempted race looks like from here.
 */
export async function openConfinedWrite(
  fence: FsFence,
  path: string,
  options: ConfinedOpenOptions = {},
): Promise<FileHandle> {
  const resolver = options.resolver ?? nodePathResolver()
  const before = await resolver.realpath(dirname(path))
  await fence.assertWritable(path)

  // `O_NOFOLLOW` does not exist on Windows, where `constants.O_NOFOLLOW` is
  // `undefined` and would silently vanish from the bitwise OR. Where the kernel
  // cannot refuse the open, refuse it here instead: not atomic, but the
  // alternative is following the link.
  const noFollow = constants.O_NOFOLLOW ?? 0
  if (noFollow === 0 && (await resolver.readLink?.(path)) !== undefined) {
    throw new SandboxDeniedError(path, 'workspace-write', fence.writableRoots)
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | noFollow
    | (options.truncate === false ? constants.O_APPEND : constants.O_TRUNC)

  let handle: FileHandle
  try {
    handle = await open(path, flags, options.mode)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ELOOP (POSIX) and EMLINK (some BSDs) are how O_NOFOLLOW reports that the
    // last component is a symlink — here, one that appeared after the check.
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new SandboxDeniedError(path, 'workspace-write', fence.writableRoots)
    }
    throw error
  }

  // The directory the file sits in can be swapped too, and `O_NOFOLLOW` says
  // nothing about it. Re-resolving it after the open does not make the sequence
  // atomic, but it does refuse the case where it changed underneath us.
  const after = await resolver.realpath(dirname(path))
  if (after !== before) {
    await handle.close()
    throw new SandboxDeniedError(path, 'workspace-write', fence.writableRoots)
  }
  return handle
}

/**
 * Write a whole file through {@link openConfinedWrite}.
 * @returns nothing; the handle is closed before returning.
 */
export async function writeConfinedFile(
  fence: FsFence,
  path: string,
  data: string | Uint8Array,
  options: ConfinedOpenOptions = {},
): Promise<void> {
  const handle = await openConfinedWrite(fence, path, options)
  try { await handle.write(data as Uint8Array) }
  finally { await handle.close() }
}
