import type { LinkedAgentResult } from './types.ts'
import type { RemoteMemberRuntime } from './team-runtime-types.ts'
import { AgentSdkError } from '../../errors/index.ts'
import { byteLength, errorMessage, combineSignals, abortable } from './common.ts'

interface RemoteDispatchHost {
  readonly maxMessages: number
  readonly maxLinkedResultBytes: number
  readonly operationTimeoutMs: number
  readonly lifecycle: AbortSignal
  readonly ownRemoteTask: ((signal: AbortSignal) => () => void) | undefined
  emit(event: any): void
}

export async function dispatchRemote(
    member: RemoteMemberRuntime,
    input: Parameters<RemoteMemberRuntime['transport']['send']>[0],
  host: RemoteDispatchHost): Promise<LinkedAgentResult> {
    if (member.pending >= host.maxMessages) {
      throw new AgentSdkError('Remote member has too many unsettled sends', 'TEAM_REMOTE_PENDING_LIMIT')
    }
    const controller = new AbortController()
    const signal = combineSignals(
      input.signal, host.lifecycle, controller.signal,
      AbortSignal.timeout(host.operationTimeoutMs),
    )
    signal.throwIfAborted()
    const releaseOwnership = host.ownRemoteTask?.(signal)
    member.controllers.add(controller)
    member.pending++
    const previous = member.tail
    const operation = (async () => {
      await previous
      signal.throwIfAborted()
      host.emit({ type: 'member-run-start', member: member.name })
      try {
        const result = await member.transport.send({ ...input, signal })
        signal.throwIfAborted()
        if (byteLength(result) > host.maxLinkedResultBytes) {
          throw new Error(`linked A2A result exceeds the ${host.maxLinkedResultBytes}-byte limit`)
        }
        member.error = undefined
        host.emit({ type: 'member-run-end', member: member.name })
        return result
      } catch (error: unknown) {
        member.error = errorMessage(error)
        host.emit({ type: 'member-run-error', member: member.name, error: member.error })
        throw error
      }
    })().finally(() => {
      member.pending--
      member.controllers.delete(controller)
      releaseOwnership?.()
    })
    member.tail = operation.then(() => undefined, () => undefined)
    return await abortable(operation, signal)
  }

