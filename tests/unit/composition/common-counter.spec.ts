import { describe, expect, it } from 'vitest'
import { saturatingCounterAdd } from '../../../packages/core/src/composition/common/counter.ts'

describe('saturating observation counters', () => {
  it('increments exactly below the limit and never wraps beyond safe precision', () => {
    expect(saturatingCounterAdd(4, 3)).toBe(7)
    expect(saturatingCounterAdd(Number.MAX_SAFE_INTEGER - 1, 1)).toBe(Number.MAX_SAFE_INTEGER)
    expect(saturatingCounterAdd(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER)
    expect(saturatingCounterAdd(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER))
      .toBe(Number.MAX_SAFE_INTEGER)
  })
})
