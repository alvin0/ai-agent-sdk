import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['../../tests/contract/public-api-baseline.spec.ts', '../../tests/contract/package-runtime-identity.spec.ts'],
  },
})
