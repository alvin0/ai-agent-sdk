import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node',
  include: ['../../tests/unit/provider-typesafe.spec.ts', '../../tests/unit/decision-adversarial.spec.ts'] } })
