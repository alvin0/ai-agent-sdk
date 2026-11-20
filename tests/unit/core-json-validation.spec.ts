import { describe, expect, it, vi } from 'vitest'
import { isJsonValue } from '../../packages/core/src/primitives/json.ts'

describe('lossless JSON validation', () => {
  it('rejects holes and additional array properties', () => {
    expect(isJsonValue([1, , 3])).toBe(false)
    expect(isJsonValue(Object.assign([1], { extra: 2 }))).toBe(false)
    expect(isJsonValue([1, 2, 3])).toBe(true)
  })

  it('rejects hidden and symbol properties that serialization would discard', () => {
    expect(isJsonValue(Object.defineProperty({}, 'hidden', { value: 1 }))).toBe(false)
    expect(isJsonValue({ [Symbol('fixture')]: 1 })).toBe(false)
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { nested: [true, null] })
    expect(isJsonValue(value)).toBe(true)
  })

  it('reads data descriptors without invoking object or array accessors', () => {
    const get = vi.fn(() => 1)
    const object = Object.defineProperty({}, 'field', { enumerable: true, get })
    const array = Object.defineProperty([1], '0', { enumerable: true, get })
    expect(isJsonValue(object)).toBe(false)
    expect(isJsonValue(array)).toBe(false)
    expect(get).not.toHaveBeenCalled()
  })

  it('contains inspection failures and distinguishes shared references from cycles', () => {
    const unreadable = new Proxy({}, { ownKeys() { throw new Error('fixture inspection failed') } })
    expect(isJsonValue(unreadable)).toBe(false)
    const shared = { value: 1 }
    expect(isJsonValue({ a: shared, b: shared })).toBe(true)
    const cycle: { child?: unknown } = {}
    cycle.child = cycle
    expect(isJsonValue(cycle)).toBe(false)
  })

  it('accepts deeply nested JSON and rejects a cycle at the same depth', () => {
    let deep: unknown = { value: 1 }
    for (let depth = 0; depth < 10000; depth++) deep = [deep]
    expect(isJsonValue(deep)).toBe(true)
    const leaf: { child?: unknown } = {}
    let cyclic: unknown = leaf
    for (let depth = 0; depth < 10000; depth++) cyclic = { child: cyclic }
    leaf.child = cyclic
    expect(isJsonValue(cyclic)).toBe(false)
  })
})
