import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'test-human/**/*.spec.ts'],
    // Integration specs reach real provider endpoints and need credentials, so
    // they stay out of the default run.
    exclude: ['tests/integration/**'],
  },
})
