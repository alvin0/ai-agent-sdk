import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@ai-agent-sdk/provider-anthropic': new URL('./src/index.ts', import.meta.url).pathname,
    '@ai-agent-sdk/testkit': new URL('../testkit/src/index.ts', import.meta.url).pathname,
  } },
  test: { environment: 'node', include: ['../../tests/unit/provider-anthropic.spec.ts'] },
})
