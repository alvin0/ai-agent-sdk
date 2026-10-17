import { statusOnly } from './team-results.ts'
import { timeoutValue } from '../../platform/config.ts'
import type { ToolRunContext } from '../tool/definition.ts'
import type { JsonValue } from '../../primitives/index.ts'
import { asJson, combineSignals, memberName, parseWaitTool } from './common.ts'
import type { TeamToolsHost } from './team-tool-host.ts'

/** Join every target, bounded by timeout, caller cancellation, or steering. */
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
  const capture = host.captureResults(name, targets)
  const finished = new AbortController()
  try {
    const steer = new AbortController()
    const caller = host.member(memberName(sender))
    if (caller !== undefined) caller.steerController = steer
    const signal = combineSignals(ctx.signal, AbortSignal.timeout(budget), steer.signal, finished.signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), budget)
    })
    const interrupted = new Promise<undefined>((resolve) => {
      steer.signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
    })
    const settled = await Promise.race([
      Promise.all(targets.map(async (target) => {
        await host.whenIdle(target, signal)
        return target
      })).then(() => targets, () => undefined),
      expiry,
      interrupted,
    ]).finally(() => {
      clearTimeout(timer)
      if (caller?.steerController === steer) caller.steerController = undefined
    })
    // The caller's own cancellation still wins; a steer does not.
    ctx.signal.throwIfAborted()
    const steered = steer.signal.aborted
    const selected = new Set(targets)
    return asJson({
      agents: host.members().filter(member => selected.has(member.name)).map(statusOnly),
      results: capture.take(),
      settled: steered ? null : settled ?? null,
      timedOut: !steered && settled === undefined,
      ...(steered ? { interrupted: true } : {}),
      // The budget actually used, which is not always the one asked
      // for: a lead that reads `timedOut` after a request below the
      // floor would otherwise misjudge how long its workers had.
      waitedMs: budget,
    })
  } catch (error: unknown) {
    capture.close(); capture.release() // A failed join returns no evidence; its claims go back to the ledger.
    throw error
  } finally { finished.abort(); capture.close(); release() }

}
