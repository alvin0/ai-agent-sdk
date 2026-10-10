import { timeoutValue } from '../../platform/config.ts'
import type { ToolRunContext } from '../tool/definition.ts'
import type { JsonValue } from '../../primitives/index.ts'
import { asJson, combineSignals, memberName, parseWaitTool } from './common.ts'
import type { TeamToolsHost } from './team-tool-host.ts'

/** Wait for one target, bounded by timeout, caller cancellation, or steering. */
export async function executeTeamWait(
  host: TeamToolsHost, caller: { name: string; sender: string },
  args: ReturnType<typeof parseWaitTool>, ctx: ToolRunContext,
): Promise<JsonValue> {
  const { name, sender } = caller
  const { targets, timeoutMs } = args

  const release = host.beginWait(name, targets)
  const budget = timeoutMs === undefined
    ? host.waitTimeoutMs
    : Math.min(
      Math.max(timeoutValue(timeoutMs), host.minWaitTimeoutMs),
      host.waitTimeoutMs,
    )
  try {
    // Returns as soon as the FIRST target settles, and always within
    // the budget. Waiting for all of them, forever, is what turned one
    // slow agent into a window that looked hung: a coordinator that
    // gets the roster back can decide for itself whether to wait again.
    //
    // The budget is enforced HERE rather than only by handing members a
    // deadline signal: a member that does not honour the signal would
    // otherwise hold the wait open past its own timeout, and a timeout
    // a callee can ignore is not a timeout.
    // A wait that cannot be interrupted is a wait the user cannot
    // correct: the caller is parked here, so its own new input has
    // nothing else to end it before the budget runs out.
    const steer = new AbortController()
    const caller = host.member(memberName(sender))
    if (caller !== undefined) caller.steerController = steer
    const signal = combineSignals(ctx.signal, AbortSignal.timeout(budget), steer.signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), budget)
    })
    const interrupted = new Promise<undefined>((resolve) => {
      steer.signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
    })
    const settled = await Promise.race([
      Promise.any(targets.map(async (target) => {
        await host.whenIdle(target, signal)
        return target
      })).then(target => target, () => undefined),
      expiry,
      interrupted,
    ]).finally(() => {
      clearTimeout(timer)
      if (caller?.steerController === steer) caller.steerController = undefined
    })
    // The caller's own cancellation still wins; a steer does not.
    ctx.signal.throwIfAborted()
    if (steer.signal.aborted) {
      return asJson({
        agents: host.members().filter(member => new Set(targets).has(member.name)),
        settled: null,
        timedOut: false,
        interrupted: true,
        waitedMs: budget,
      })
    }
    const selected = new Set(targets)
    return asJson({
      agents: host.members().filter(member => selected.has(member.name)),
      settled: settled ?? null,
      timedOut: settled === undefined,
      // The budget actually used, which is not always the one asked
      // for: a lead that reads `timedOut` after a request below the
      // floor would otherwise misjudge how long its workers had.
      waitedMs: budget,
    })
  } finally { release() }

}
