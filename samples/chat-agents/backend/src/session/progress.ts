import type { AgentTeam } from '@alvin0/ai-agent-sdk-core/agent'
import type { WireEvent } from '../wire'

type Notice = Extract<WireEvent, { t: 'notice' }>
/** User-facing notices use the stream; they never inject into the lead session. */
export function listenTeamProgress(team: Pick<AgentTeam, 'subscribe'>, signal: AbortSignal,
  notify: (notice: Notice) => void): () => void {
  const unsubscribe = team.subscribe(event => {
    if (event.type === 'team-progress') notify({ t: 'notice', level: 'info', message: event.text })
  })
  signal.addEventListener('abort', unsubscribe, { once: true })
  if (signal.aborted) unsubscribe()
  return () => {
    unsubscribe()
    signal.removeEventListener('abort', unsubscribe)
  }
}
