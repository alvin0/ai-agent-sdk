import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@ai-agent-sdk/observability-otel': new URL('./src/index.ts', import.meta.url).pathname } },
  test: { environment: 'node', include: ['../../tests/unit/observability-otel.spec.ts'] },
})
