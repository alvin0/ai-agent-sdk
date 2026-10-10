import type { CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
import { type CapturedCopilotStore } from './common/store-capture.ts'
import type { CopilotAuthFile } from './common/store-types.ts'
import { COPILOT_SLOW_DOWN_INCREMENT_SECONDS, DEFAULT_COPILOT_TIMER } from './oauth-types.ts'
import type { CopilotTimer, CopilotOAuthOptions, CopilotStoreSnapshot } from './oauth-types.ts'
import { deviceAborted } from './oauth-errors.ts'
import { positiveSecondsOf } from './oauth-values.ts'

/**
 * The effective wait after a `slow_down`, which must STRICTLY increase.
 *
 * `max(current, server-requested, current + 5)` — the third term is what keeps
 * the sequence increasing when the server sends no new `interval`, and taking the
 * max of all three keeps it from ever decreasing when the server sends a smaller
 * one. `authorization_pending` may carry a new interval too; there it is honoured
 * without the increment, so an ordinary pending poll does not back off forever.
 */
export function nextIntervalSeconds(
  current: number,
  requested: unknown,
  error: 'authorization_pending' | 'slow_down',
): number {
  const server = positiveSecondsOf(requested, 0)
  return error === 'slow_down'
    ? Math.max(current, server, current + COPILOT_SLOW_DOWN_INCREMENT_SECONDS)
    : Math.max(current, server)
}

/**
 * Wait `ms`, losing the race to `signal` the instant it aborts.
 *
 * The timer is injected rather than closed over, so a test can drive the poll
 * loop through fifteen virtual minutes in a millisecond. Aborting rejects instead
 * of resolving early, because a caller who pressed Ctrl-C wants the flow to END,
 * not to take one more turn round the loop.
 */
export function sleep(ms: number, signal: AbortSignal | undefined, timer: CopilotTimer): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(deviceAborted())
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      timer.clearTimeout(handle)
      reject(deviceAborted())
    }
    const handle = timer.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function timerOf(options: CopilotOAuthOptions): CopilotTimer {
  return options.timer ?? DEFAULT_COPILOT_TIMER
}

/** Run a progress observer; observers do not own authentication. */
export function notify(report: () => void): void {
  try {
    report()
  } catch { /* a CLI's rendering must not decide whether a login succeeds */ }
}

export async function readStore(
  captured: CapturedCopilotStore,
  operation: CredentialOperationOptions,
): Promise<CopilotStoreSnapshot> {
  if (captured.kind === 'versioned') {
    const record = await captured.store.read(operation)
    return record === undefined
      ? { file: undefined, revision: null }
      : { file: record.value, revision: record.revision }
  }
  return { file: await captured.store.read(), revision: null }
}

export async function commitStore(
  captured: CapturedCopilotStore,
  file: CopilotAuthFile,
  expectedRevision: string | null,
  operation: CredentialOperationOptions,
): Promise<void> {
  if (captured.kind === 'versioned') {
    await captured.store.commit({ value: file, expectedRevision }, operation)
    return
  }
  await captured.store.write(file)
}
