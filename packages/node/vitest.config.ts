import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@ai-agent-sdk/node': new URL('./src/index.ts', import.meta.url).pathname,
  } },
  test: { environment: 'node', include: ['../../tests/unit/node-facade.spec.ts'] },
})
