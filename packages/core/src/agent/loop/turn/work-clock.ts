/** Charge work time while excluding intervals spent solely waiting for a person. */
export function createTurnClock(): {
  toolActivity: (awaitsPerson: boolean, active: boolean) => void
  timeSpent: () => number
} {
  const startedMs = Date.now()
  let personWaitMs = 0
  let waitingSince: number | undefined
  let personCalls = 0
  let workCalls = 0
  return {
    toolActivity: (awaitsPerson: boolean, active: boolean): void => {
      const at = Date.now()
      if (waitingSince !== undefined) personWaitMs += at - waitingSince
      if (awaitsPerson) personCalls += active ? 1 : -1
      else workCalls += active ? 1 : -1
      waitingSince = personCalls > 0 && workCalls === 0 ? at : undefined
    },
    timeSpent: (): number => {
      const at = Date.now()
      return at - startedMs - personWaitMs - (waitingSince === undefined ? 0 : at - waitingSince)
    },
  }
}
