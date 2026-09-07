/**
 * Workspace roots.
 *
 * The agent must not roam the machine, so every filesystem tool is confined to
 * one directory chosen here: a sandbox created next to the sample by default,
 * or a folder the user picks in the UI. The picker browses server-side because
 * a browser cannot hand a real path to the backend.
 */

import { mkdirSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { database, schema } from './db/client'

const SETTING_KEY = 'workspace.root'

const SANDBOX_README = `# chat-agents workspace

The sample agent reads and searches inside this folder. Drop files here, or pick
another folder from the workspace picker in the UI.
`

/**
 * The default sandbox, created on first use.
 * @returns Absolute path to the sample's own workspace directory.
 */
export function defaultWorkspace(): string {
  const root = process.env.CHAT_AGENTS_WORKSPACE ?? resolve(process.cwd(), '.workspace')
  mkdirSync(root, { recursive: true })
  const readme = join(root, 'README.md')
  if (!existsSync(readme)) writeFileSync(readme, SANDBOX_README, 'utf8')
  return root
}

/**
 * The workspace the next run will use.
 * @returns The stored choice, or the sandbox.
 */
export async function currentWorkspace(): Promise<string> {
  const { db } = database()
  const row = await db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, SETTING_KEY)).all().then(rows => rows[0])
  const stored = row?.value
  if (stored !== undefined && stored.length > 0 && existsSync(stored)) return stored
  return defaultWorkspace()
}

/**
 * Choose the workspace.
 * @param root - Absolute directory path.
 * @returns The stored absolute path.
 * @throws When the path is not an existing directory.
 */
export async function setWorkspace(root: string): Promise<string> {
  const absolute = isAbsolute(root) ? resolve(root) : resolve(process.cwd(), root)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`not a directory: ${absolute}`)
  }
  const { db } = database()
  const existing = await db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, SETTING_KEY)).all().then(rows => rows[0])
  if (existing === undefined) {
    await db.insert(schema.appSettings).values({ key: SETTING_KEY, value: absolute }).run()
  } else {
    await db.update(schema.appSettings).set({ value: absolute })
      .where(eq(schema.appSettings.key, SETTING_KEY)).run()
  }
  return absolute
}

export interface DirectoryEntry {
  readonly name: string
  readonly path: string
}

export interface DirectoryListing {
  readonly path: string
  readonly parent: string | undefined
  readonly entries: readonly DirectoryEntry[]
}

/**
 * List the subdirectories of one directory, for the picker.
 * @param path - Directory to list; defaults to the user's home.
 * @returns The listing, with the parent for upward navigation.
 * @throws When the path is not a readable directory.
 */
export function browseDirectory(path?: string): DirectoryListing {
  const target = path === undefined || path.length === 0 ? homedir() : resolve(path)
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error(`not a directory: ${target}`)
  }
  const entries: DirectoryEntry[] = []
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    entries.push({ name: entry.name, path: join(target, entry.name) })
    if (entries.length >= 500) break
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const parent = resolve(target, '..')
  return {
    path: target,
    parent: parent === target ? undefined : parent,
    entries,
  }
}
