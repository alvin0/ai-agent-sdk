import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@alvin0/ai-agent-sdk-testkit': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/provider-testkit.spec.ts',
      // Property 41 at the harness layer: drives the assembled Copilot adapter
      // against an existing provider using this package's Copilot harness data
      // and its token-exchange responder.
      '../../tests/unit/copilot-cross-provider-errors.spec.ts',
    ],
  },
})
