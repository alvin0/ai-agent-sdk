import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      '../../tests/unit/assembler.spec.ts',
      '../../tests/unit/idle-timeout.spec.ts',
      '../../tests/unit/observation-core.spec.ts',
      '../../tests/unit/provider-plugin.spec.ts',
      '../../tests/unit/registry.spec.ts',
      '../../tests/unit/retry-policy.spec.ts',
      '../../tests/unit/usage-accounting.spec.ts',
      '../../tests/unit/with-retry.spec.ts'
    ]
  }
})
