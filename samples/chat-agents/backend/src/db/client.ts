/**
 * Database bootstrap: Node's built-in `node:sqlite` driver behind Drizzle's
 * proxy dialect. The built-in driver keeps the sample free of a native build
 * step while Drizzle still owns the schema and the queries.
 */

import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema'

/**
 * Where drizzle-kit writes its generated migrations.
 *
 * A bundler rewrites `import.meta.url` to its own output path, so a host that
 * bundles this package points at the directory explicitly.
 */
function migrationsDirectory(): string {
  const configured = process.env.CHAT_AGENTS_MIGRATIONS
  if (configured !== undefined && configured.length > 0) return resolve(configured)
  const here = dirname(fileURLToPath(import.meta.url))
  // src/db → package root → drizzle/
  return resolve(here, '../../drizzle')
}

/**
 * Apply every generated migration that has not run yet.
 *
 * The runtime deliberately executes the SAME SQL drizzle-kit generates from
 * `schema.ts`, so the schema cannot drift from the tables.
 * @param sqlite - The open database.
 */
/** The generated migration file names, in apply order. */
function migrationFiles(): readonly string[] {
  const directory = migrationsDirectory()
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => name.endsWith('.sql')).sort()
}

function migrate(sqlite: DatabaseSync): void {
  sqlite.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const directory = migrationsDirectory()
  const applied = new Set(
    sqlite.prepare('SELECT name FROM _migrations').all().map(row => (row as { name: string }).name),
  )
  for (const file of migrationFiles()) {
    if (applied.has(file)) continue
    const sql = readFileSync(join(directory, file), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed.length === 0) continue
      try {
        sqlite.exec(trimmed)
      } catch (error) {
        // A database created before migrations were tracked already has these
        // objects; anything else is a real failure.
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('already exists')) throw error
      }
    }
    sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
      .run(file, Math.floor(Date.now() / 1000))
  }
}

const DB_KEY = Symbol.for('@chat-agents/backend.db')

interface Handle {
  readonly sqlite: DatabaseSync
  readonly db: ReturnType<typeof drizzle<typeof schema>>
  readonly file: string
  /** Migration files seen the last time this handle was checked. */
  applied: number
}

/**
 * Where the SQLite file lives.
 * @returns Absolute path; `CHAT_AGENTS_DB` overrides the default.
 */
export function databaseFile(): string {
  return process.env.CHAT_AGENTS_DB ?? resolve(process.cwd(), '.data/chat-agents.db')
}

/**
 * Open (once per process) the database and apply the schema.
 * @returns The Drizzle handle bound to the built-in driver.
 */
export function database(): Handle {
  const holder = globalThis as unknown as Record<symbol, Handle | undefined>
  const existing = holder[DB_KEY]
  if (existing !== undefined) {
    // The handle outlives a dev hot reload, so a migration added since it was
    // opened would otherwise never run.
    const pending = migrationFiles().length
    if (pending !== existing.applied) {
      migrate(existing.sqlite)
      existing.applied = pending
    }
    return existing
  }

  const file = databaseFile()
  mkdirSync(dirname(file), { recursive: true })
  const sqlite = new DatabaseSync(file)
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA foreign_keys = ON')
  migrate(sqlite)

  // Drizzle's proxy dialect hands us prepared SQL and expects rows as arrays.
  const db = drizzle<typeof schema>(async (query, params, method) => {
    const statement = sqlite.prepare(query)
    if (method === 'run') {
      statement.run(...params as never[])
      return { rows: [] }
    }
    const rows = statement.all(...params as never[]).map(row => Object.values(row as object))
    return method === 'get' ? { rows: rows[0] ?? [] } : { rows }
  }, { schema })

  const handle: Handle = { sqlite, db, file, applied: migrationFiles().length }
  holder[DB_KEY] = handle
  return handle
}

export { schema }
