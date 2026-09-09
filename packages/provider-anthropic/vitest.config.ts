import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@alvin0/ai-agent-sdk-provider-anthropic': new URL('./src/index.ts', import.meta.url).pathname,
    '@alvin0/ai-agent-sdk-testkit': new URL('../testkit/src/index.ts', import.meta.url).pathname,
  } },
  test: { environment: 'node', include: ['../../tests/unit/provider-anthropic.spec.ts'] },
})
