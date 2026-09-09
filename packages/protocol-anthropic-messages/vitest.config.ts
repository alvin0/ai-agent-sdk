import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@alvin0/ai-agent-sdk-protocol-anthropic-messages': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/anthropic-serialize.spec.ts',
      '../../tests/unit/anthropic-translate.spec.ts',
    ],
  },
})
