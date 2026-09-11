import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@alvin0/ai-agent-sdk-protocol-openai-chat-completions': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/chat-completions-serialize.spec.ts',
      '../../tests/unit/chat-completions-translate-text.spec.ts',
      '../../tests/unit/chat-completions-translate-tools.spec.ts',
      '../../tests/unit/chat-completions-translate-terminal.spec.ts',
      '../../tests/unit/chat-completions-errors.spec.ts',
      '../../tests/unit/chat-completions-surface.spec.ts',
    ],
  },
})
