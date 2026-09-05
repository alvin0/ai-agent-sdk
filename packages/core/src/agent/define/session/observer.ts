import { waitForSettlement } from '../../../async/index.ts'
import type { AgentRunEvent } from '../../mode/run-agent.ts'

export async function consumeSessionEvents(
  events: AsyncIterable<AgentRunEvent>,
  observer: ((event: AgentRunEvent) => void | Promise<void>) | undefined,
  timeoutMs: number,
): Promise<void> {
  for await (const event of events) {
    if (observer === undefined) continue
    await waitForSettlement(Promise.resolve().then(() => observer(event)), timeoutMs)
  }
}
