import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@alvin0/ai-agent-sdk-provider-http': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/http-errors.spec.ts',
      '../../tests/unit/http-provider.spec.ts',
      '../../tests/unit/sse.spec.ts',
    ],
  },
})
