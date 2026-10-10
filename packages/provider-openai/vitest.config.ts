import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@alvin0/ai-agent-sdk-provider-openai/decisions': new URL('./src/decisions.ts', import.meta.url).pathname,
    '@alvin0/ai-agent-sdk-provider-openai': new URL('./src/index.ts', import.meta.url).pathname,
    '@alvin0/ai-agent-sdk-testkit': new URL('../testkit/src/index.ts', import.meta.url).pathname,
  } },
  test: {
    environment: 'node',
    include: ['../../tests/unit/provider-openai.spec.ts', '../../tests/unit/provider-openai-decisions.spec.ts'],
  },
})
