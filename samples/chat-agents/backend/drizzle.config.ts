import { defineConfig } from 'drizzle-kit'

// Schema management only: the runtime opens the same file through node:sqlite.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.CHAT_AGENTS_DB ?? '.data/chat-agents.db' },
})
