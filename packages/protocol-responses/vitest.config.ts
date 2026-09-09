import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@alvin0/ai-agent-sdk-protocol-responses': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/responses-serialize.spec.ts',
      '../../tests/unit/responses-translate.spec.ts',
    ],
  },
})
