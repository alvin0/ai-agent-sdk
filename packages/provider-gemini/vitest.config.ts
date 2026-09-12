import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@alvin0/ai-agent-sdk-provider-gemini': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    // Specs live in the ROOT `tests/` tree; this package has no `tests/`
    // directory, so listing them here is what makes them run under
    // `pnpm --filter provider-gemini test` as well as the root suite.
    include: [
      '../../tests/unit/provider-gemini.spec.ts',
      '../../tests/unit/provider-gemini-embedding.spec.ts',
    ],
  },
})
