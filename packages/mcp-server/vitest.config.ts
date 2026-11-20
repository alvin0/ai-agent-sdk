import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@alvin0/ai-agent-sdk-mcp-server': new URL('./src/index.ts', import.meta.url).pathname,
  } },
  test: { environment: 'node', include: [
    '../../tests/unit/mcp-server.spec.ts',
    '../../tests/unit/mcp-server-request-body.spec.ts',
    '../../tests/unit/mcp-server-schema-lifetime.spec.ts',
  ] },
})
