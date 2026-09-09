import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@alvin0/ai-agent-sdk-mcp-node-server': new URL('./src/index.ts', import.meta.url).pathname,
    '@alvin0/ai-agent-sdk-mcp-server': new URL('../mcp-server/src/index.ts', import.meta.url).pathname,
  } },
  test: { environment: 'node', include: ['../../tests/unit/mcp-node-server.spec.ts'] },
})
