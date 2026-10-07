import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node',
  include: ['../../tests/unit/decision-adapter.spec.ts', '../../tests/unit/decision-llm.spec.ts',
    '../../tests/unit/decision-quality.spec.ts', '../../tests/unit/decision-adversarial.spec.ts',
    '../../tests/unit/decision-core-integration.spec.ts'] } })
