import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@alvin0/ai-agent-sdk-sandbox-node': new URL('./src/index.ts', import.meta.url).pathname,
    '@alvin0/ai-agent-sdk-sandbox': new URL('../sandbox/src/index.ts', import.meta.url).pathname,
  } },
  test: { environment: 'node', include: ['../../tests/unit/sandbox-node.spec.ts'] },
})
