import { createTurnState } from './turn/state.ts'
import { executeTurn, reportTurnFailure } from './turn/lifecycle.ts'
import { detachedFrozen } from '../../primitives/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import type { AgentEvent } from './types.ts'
import { AwaitedEventQueue } from './queue.ts'
import { type RunTurnOptions } from './turn/types.ts'
import { positiveFinite, snapshotRunTurnOptions } from './turn/config.ts'
import { codedRuntimeError } from './turn/common.ts'

/** Run one bounded turn as a backpressured event stream. */
export function runTurn(options: RunTurnOptions): AsyncIterable<AgentEvent> {
  return {
    async * [Symbol.asyncIterator]() {
      const invocation = snapshotRunTurnOptions(options)
      const queue = new AwaitedEventQueue<AgentEvent>()
      const consumer = new AbortController()
      const teardownTimeoutMs = positiveFinite(invocation.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
      const signal = invocation.signal === undefined
        ? consumer.signal
        : AbortSignal.any([invocation.signal, consumer.signal])
      const task = driveTurn(invocation, signal, event => queue.push(detachedFrozen(event)))
        .then(() => queue.close(), error => queue.fail(error))
      try {
        while (true) {
          const item = await queue.take()
          if (item.done) break
          yield item.value
        }
        await task
      } finally {
        consumer.abort(new Error('turn event consumer stopped'))
        queue.close()
        if (!await waitForSettlement(task, teardownTimeoutMs)) {
          throw codedRuntimeError(
            `turn producer ignored cancellation for more than ${teardownTimeoutMs}ms`,
            'TURN_TEARDOWN_TIMEOUT',
            consumer.signal.reason,
          )
        }
      }
    },
  }
}

async function driveTurn(
  options: RunTurnOptions, signal: AbortSignal, emit: (event: AgentEvent) => Promise<void>,
): Promise<void> {
  const state = createTurnState(options, signal, emit)
  try {
    await executeTurn(state)
  } catch (error: unknown) {
    await reportTurnFailure(state, error)
    throw error
  } finally {
    state.programResults?.close()
  }
}

export type { RunTurnOptions } from './turn/types.ts'
