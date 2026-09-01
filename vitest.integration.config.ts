import { defineConfig } from 'vitest/config'

/**
 * Integration tests reach real provider endpoints, so they are a separate run:
 * they need credentials, they cost tokens, and they are slow enough that mixing
 * them into `npm test` would discourage running the fast suite.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // A live model is not deterministic and the endpoints rate-limit; running the
    // files one at a time keeps failures readable and avoids self-inflicted 429s.
    fileParallelism: false,
  },
})
