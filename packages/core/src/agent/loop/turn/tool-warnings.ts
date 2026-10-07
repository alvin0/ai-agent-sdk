import { createUserMessage } from '../../../message/index.ts'
import type { RunTurnOptions } from './types.ts'
import type { modelRound } from './model-round.ts'
import type { repeatedSuffixCycle } from './repetition.ts'

export function warnDuplicateToolIds(
  options: RunTurnOptions, ids: Awaited<ReturnType<typeof modelRound>>['droppedDuplicateCalls'],
): void {
    if (ids !== undefined) {
      options.history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'tool-loop-duplicate-guard' },
        content: [{
          type: 'text',
          text: `You reused the tool-call id ${ids.map(id => `'${id}'`).join(', ')}.`
            + ' A result pairs to exactly one call, so the repeat was not run and only the first'
            + ' call of that id has a result. Give every call its own id, and call again if you'
            + ' still need what the dropped one would have done.',
        }],
      }) })
    }

}

export function warnToolCycle(
  options: RunTurnOptions, projectedCycle: ReturnType<typeof repeatedSuffixCycle>, warningAt: number,
): void {
    if (projectedCycle?.repetitions === warningAt) {
      options.history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'tool-loop-cycle-guard' },
        content: [{
          type: 'text',
          text: `Tool-use pattern repeated ${projectedCycle.repetitions} times across `
            + `${projectedCycle.period} step(s). Reassess the approach and identify concrete new evidence `
            + 'before continuing.',
        }],
      }) })
    }

}
