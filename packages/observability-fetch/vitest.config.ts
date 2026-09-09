import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@alvin0/ai-agent-sdk-observability-fetch': new URL('./src/index.ts', import.meta.url).pathname } },
  test: { environment: 'node', include: ['../../tests/unit/observability-fetch.spec.ts'] },
})
