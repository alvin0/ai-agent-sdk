import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['../../tests/unit/antigravity{,-audit,-image}.spec.ts'] },
})
