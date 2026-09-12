import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@alvin0/ai-agent-sdk-provider-copilot': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/copilot-client-identity.spec.ts',
      '../../tests/unit/copilot-no-follow.spec.ts',
      '../../tests/unit/copilot-auth-store.spec.ts',
      '../../tests/unit/copilot-oauth-device.spec.ts',
      '../../tests/unit/copilot-exchange.spec.ts',
      '../../tests/unit/copilot-token-cache.spec.ts',
      '../../tests/unit/copilot-catalog.spec.ts',
      '../../tests/unit/copilot-router.spec.ts',
      '../../tests/unit/copilot-adapter-headers.spec.ts',
      '../../tests/unit/copilot-attempts.spec.ts',
      '../../tests/unit/copilot-redaction.spec.ts',
      '../../tests/unit/copilot-surface.spec.ts',
      '../../tests/unit/copilot-architecture.spec.ts',
      '../../tests/unit/copilot-embedding-request.spec.ts',
      '../../tests/unit/copilot-embedding-response.spec.ts',
      '../../tests/unit/copilot-embedding-profile.spec.ts',
    ],
  },
})
