import type { ResolvedModel } from '../registry'
import type { StoredNode } from '../event-projection'
import type { readPromptSelection } from './preparation'

export type PromptRunContext = Awaited<ReturnType<typeof readPromptSelection>> & {
  readonly id: string
  readonly prompt: string
  readonly controller: AbortController
  readonly runId: string
  readonly model: ResolvedModel
  readonly effort: string | undefined
  persist(node: StoredNode): Promise<void>
}
