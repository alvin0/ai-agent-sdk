import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@ai-agent-sdk/mcp/client': new URL('./src/client.ts', import.meta.url).pathname,
    '@ai-agent-sdk/mcp/server': new URL('./src/server.ts', import.meta.url).pathname,
    '@ai-agent-sdk/mcp': new URL('./src/index.ts', import.meta.url).pathname,
  } },
  test: { environment: 'node', include: ['../../tests/unit/mcp.spec.ts'] },
})
