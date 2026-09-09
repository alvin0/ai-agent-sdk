/**
 * Durable spill storage for oversized tool output.
 *
 * The SDK ships an in-process store, which loses everything on restart — fine
 * for a browser, wrong for a host that keeps conversations across restarts: a
 * transcript would show "the full output is saved" next to a locator that no
 * longer resolves. This writes the text next to the database instead, so the
 * promise the model reads stays true for the life of the conversation.
 *
 * Files never live in the workspace. The agent's own filesystem tools are
 * confined to that directory, and putting spill inside it would let a run
 * discover, edit, or delete another conversation's output through the ordinary
 * read and write tools.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { SpillRecord, SpillSlice, SpillStore } from '@alvin0/ai-agent-sdk-core/agent'
import { databaseFile } from './db/client'

/** How long a spilled file survives before startup cleanup removes it. */
const RETENTION_MS = 7 * 24 * 60 * 60_000

/**
 * Where spilled output lives.
 * @returns Absolute directory, created on first use.
 */
export function spillRoot(): string {
  const root = process.env.CHAT_AGENTS_SPILL ?? resolve(dirname(databaseFile()), 'spill')
  // 0o700: the text is whatever a tool read or produced, which routinely means
  // source, logs, and secrets in environment dumps.
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

/**
 * Delete spilled files older than the retention window.
 *
 * Called at startup rather than on a timer: the files only matter while their
 * conversation is being read, and a sweep that runs while nothing is happening
 * cannot interrupt a run.
 * @returns How many files were removed.
 */
export function sweepSpill(): number {
  const root = spillRoot()
  const cutoff = Date.now() - RETENTION_MS
  let removed = 0
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    try {
      if (statSync(path).mtimeMs >= cutoff) continue
      rmSync(path, { force: true })
      removed++
    } catch {
      // A file removed by something else is the outcome this wanted anyway.
    }
  }
  return removed
}

/**
 * A locator names one file, and nothing else.
 *
 * The locator travels through the model, so it is attacker-influenced text by
 * the time it comes back: it is matched against a strict shape and joined to
 * the root, never interpolated into a path. `..`, an absolute path, and a
 * symlink name all fail the pattern rather than escaping the directory.
 * @param locator - The locator to resolve.
 * @returns The file path, or undefined when the locator is not one of ours.
 */
function pathFor(locator: string): string | undefined {
  const match = /^spill:([0-9a-f]{32})$/.exec(locator)
  if (match === null) return undefined
  const path = join(spillRoot(), `${match[1] as string}.txt`)
  return existsSync(path) ? path : undefined
}

function readAll(locator: string): string | undefined {
  const path = pathFor(locator)
  if (path === undefined) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * A spill store backed by files next to the database.
 * @returns The store, ready to mount on a session.
 */
export function createFileSpillStore(): SpillStore {
  return {
    save(text, context): SpillRecord {
      const id = randomBytes(16).toString('hex')
      const path = join(spillRoot(), `${id}.txt`)
      writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 })
      const locator = `spill:${id}`
      return {
        locator,
        bytes: Buffer.byteLength(text, 'utf8'),
        // The agent's own read_file cannot reach this directory by design, so
        // the guidance names the tool that can.
        retrieval: `Call read_tool_output with locator "${locator}" to read it,`
          + ` or with a pattern to search it. Output of ${context.toolName} is kept for 7 days.`,
      }
    },
    read(locator, range): SpillSlice | undefined {
      const text = readAll(locator)
      if (text === undefined) return undefined
      const points = [...text]
      const offset = Math.min(Math.max(0, range.offset), points.length)
      return {
        text: points.slice(offset, offset + Math.max(1, range.limit)).join(''),
        totalChars: points.length,
        offset,
      }
    },
    search(locator, pattern, limit): readonly string[] | undefined {
      const text = readAll(locator)
      if (text === undefined) return undefined
      const expression = new RegExp(pattern)
      const found: string[] = []
      const lines = text.split('\n')
      for (let index = 0; index < lines.length && found.length < limit; index++) {
        const line = lines[index] ?? ''
        if (expression.test(line)) found.push(`${String(index + 1)}: ${line}`)
      }
      return found
    },
  }
}

/**
 * A stable fingerprint of a locator, for logs.
 * @param locator - The locator.
 * @returns Eight hex characters; never the locator itself.
 */
export function spillFingerprint(locator: string): string {
  return createHash('sha256').update(locator).digest('hex').slice(0, 8)
}
