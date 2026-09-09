import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@alvin0/ai-agent-sdk-protocol-gemini-interactions': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/gemini-interactions-serialize.spec.ts',
      '../../tests/unit/gemini-interactions-translate.spec.ts',
    ],
  },
})
