import { describe, expect, it } from 'vitest'
import { withIdleTimeout } from '@ai-agent-sdk/core'

describe('withIdleTimeout', () => {
  it('does not wait forever for an uncooperative iterator return', async () => {
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<number>>(() => {}),
          return: () => new Promise<IteratorResult<number>>(() => {}),
        }
      },
    }
    const started = Date.now()
    await expect(async () => {
      for await (const _value of withIdleTimeout(
        source,
        10,
        () => new Error('idle'),
        10,
      )) { /* drain */ }
    }).rejects.toThrow('ignored cancellation')
    expect(Date.now() - started).toBeLessThan(250)
  })
})
