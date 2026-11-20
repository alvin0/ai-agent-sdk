import { expect, it } from 'vitest'
import { safeProviderFailure } from '../../../packages/provider-http/src/transport/http.ts'

it.each(['TIMEOUT', 'HTTP_503', 'CUSTOM_PROVIDER_FAILURE'])('preserves stable diagnostic code %s', code => {
  expect(safeProviderFailure({ message: 'ordinary fixture message', code, status: 503 }))
    .toMatchObject({ code, status: 503 })
})

it.each(['fixture display label', 'x'.repeat(129), ''])('omits prose and unbounded diagnostic codes', code => {
  const report = safeProviderFailure({ message: 'ordinary fixture message', code, status: 503 })
  expect(report.code).toBeUndefined()
  expect(report.status).toBe(503)
  expect(report.message).not.toContain('ordinary fixture message')
})
