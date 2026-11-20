import { expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }))

it('revalidates evicted profiles and keeps recently validated results cached', async () => {
  vi.resetModules()
  const { spawnSync } = await import('node:child_process')
  const { seatbeltProfileAccepted } = await import('../../packages/sandbox-node/src/backends/seatbelt.ts')
  vi.mocked(spawnSync).mockClear()
  for (let index = 0; index < 200; index++) expect(seatbeltProfileAccepted(`profile ${index}`)).toBe(true)
  expect(spawnSync).toHaveBeenCalledTimes(200)
  expect(seatbeltProfileAccepted('profile 199')).toBe(true)
  expect(spawnSync).toHaveBeenCalledTimes(200)
  expect(seatbeltProfileAccepted('profile 0')).toBe(true)
  expect(spawnSync).toHaveBeenCalledTimes(201)
})

it('revalidates oversized profiles while preserving ordinary cache entries', async () => {
  vi.resetModules()
  const { spawnSync } = await import('node:child_process')
  const { seatbeltProfileAccepted } = await import('../../packages/sandbox-node/src/backends/seatbelt.ts')
  vi.mocked(spawnSync).mockClear()
  expect(seatbeltProfileAccepted('ordinary')).toBe(true)
  const large = 'x'.repeat(1_048_576)
  expect(seatbeltProfileAccepted(large)).toBe(true)
  expect(seatbeltProfileAccepted(large)).toBe(true)
  expect(seatbeltProfileAccepted('ordinary')).toBe(true)
  expect(spawnSync).toHaveBeenCalledTimes(3)
})

it('evicts profiles when their text fills the cache byte allowance', async () => {
  vi.resetModules()
  const { spawnSync } = await import('node:child_process')
  const { seatbeltProfileAccepted } = await import('../../packages/sandbox-node/src/backends/seatbelt.ts')
  vi.mocked(spawnSync).mockClear()
  const profile = (index: number) => `${index} ${'x'.repeat(16_384)}`
  for (let index = 0; index < 40; index++) expect(seatbeltProfileAccepted(profile(index))).toBe(true)
  expect(seatbeltProfileAccepted(profile(39))).toBe(true)
  expect(spawnSync).toHaveBeenCalledTimes(40)
  expect(seatbeltProfileAccepted(profile(0))).toBe(true)
  expect(spawnSync).toHaveBeenCalledTimes(41)
})
