import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@ai-agent-sdk/provider-codex': new URL('./src/index.ts', import.meta.url).pathname } },
  test: {
    environment: 'node',
    include: ['../../tests/unit/provider-codex.spec.ts', '../../tests/unit/codex-oauth.spec.ts'],
  },
})
