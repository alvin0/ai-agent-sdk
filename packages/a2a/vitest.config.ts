import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: {
    '@ai-agent-sdk/a2a/client': new URL('./src/client.ts', import.meta.url).pathname,
    '@ai-agent-sdk/a2a/server': new URL('./src/server.ts', import.meta.url).pathname,
    '@ai-agent-sdk/a2a': new URL('./src/index.ts', import.meta.url).pathname,
  } },
  test: { environment: 'node', include: ['../../tests/unit/a2a-protocol.spec.ts'] },
})
