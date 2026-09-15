/** Node filesystem facts for the Universal contract's injected resolver. */

import { lstat, readlink, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { PathResolver } from '@alvin0/ai-agent-sdk-sandbox'
import { normalizePath } from '@alvin0/ai-agent-sdk-sandbox'

/** A resolver backed by the real filesystem. */
export function nodePathResolver(): PathResolver {
  return Object.freeze({
    async realpath(path: string): Promise<string> {
      let current = path
      const missing: string[] = []
      while (true) {
        try {
          const existing = await realpath(current)
          return normalizePath(join(existing, ...missing.reverse()))
        } catch {
          const parent = dirname(current)
          if (parent === current) return normalizePath(path)
          missing.push(basename(current))
          current = parent
        }
      }
    },
    async exists(path: string): Promise<boolean> {
      // `lstat`, not `stat`: a symbolic link whose target is missing still
      // exists, and judging it absent would resolve the link's own name.
      try { await lstat(path); return true }
      catch { return false }
    },
    async readLink(path: string): Promise<string | undefined> {
      try { return (await lstat(path)).isSymbolicLink() ? await readlink(path) : undefined }
      catch { return undefined }
    },
    async hardLinkCount(path: string): Promise<number> {
      try { return (await stat(path)).nlink }
      catch { return 1 }
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

/**
 * Paths hidden from every confined execution by default.
 *
 * Two classes, both demonstrated to matter. Credential stores because reading
 * is otherwise unconfined — the host filesystem is bound read-only, so a
 * private key is as readable inside the sandbox as outside it. Host daemon
 * sockets because connecting to one is not a file write and therefore passes
 * straight through a write boundary: a reachable container socket is host root,
 * and an agent socket signs on the user's behalf.
 */
export function hardenedDeniedPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const home = homedir()
  const paths = [
    join(home, '.ssh'), join(home, '.aws'), join(home, '.gnupg'), join(home, '.kube'),
    join(home, '.docker'), join(home, '.config', 'gh'), join(home, '.config', 'gcloud'),
    join(home, '.npmrc'), join(home, '.netrc'), join(home, '.git-credentials'),
    '/var/run/docker.sock', '/run/docker.sock',
    '/var/run/podman/podman.sock', '/run/podman/podman.sock',
    '/run/containerd/containerd.sock', '/var/run/dbus',
  ]
  const agent = env['SSH_AUTH_SOCK']
  if (agent !== undefined && agent !== '') paths.push(agent)
  const dockerHost = env['DOCKER_HOST']
  if (dockerHost?.startsWith('unix://') === true) paths.push(dockerHost.slice('unix://'.length))
  return Object.freeze(paths.map(path => normalizePath(path)))
}
