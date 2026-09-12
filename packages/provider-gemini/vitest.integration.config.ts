import { defineConfig } from 'vitest/config'
/**
 * The Gemini live embedding run, reachable from this package.
 *
 * The specs themselves live in the ROOT `tests/integration/` tree and are collected
 * by the root `vitest.integration.config.ts` — this package has no `tests/` directory,
 * exactly as `vitest.config.ts` here notes for the unit specs. Listing the file here
 * is what makes `pnpm --filter @alvin0/ai-agent-sdk-provider-gemini test:integration`
 * work as well as the root `npm run test:integration`.
 *
 * Separate from `vitest.config.ts` because these tests reach the real endpoint: they
 * need `GEMINI_KEY`, they cost quota, and they are slow enough that folding them into
 * the fast suite would discourage running it. With no credential they skip themselves;
 * see `tests/fixtures/embedding/gemini-live.ts`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['../../tests/integration/gemini-embedding.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // A live model is not deterministic and the endpoint rate-limits; one file at a
    // time keeps failures readable and avoids self-inflicted 429s.
    fileParallelism: false,
  },
})
