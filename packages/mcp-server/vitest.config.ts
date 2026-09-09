import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@ai-agent-sdk/mcp-server': new URL('./src/index.ts', import.meta.url).pathname,
  } },
  test: { environment: 'node', include: ['../../tests/unit/mcp-server.spec.ts'] },
})
