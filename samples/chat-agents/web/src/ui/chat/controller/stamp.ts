import type { ChatNode } from '../types'

export function stamped<T extends ChatNode>(node: T): T {
  return { ...node, at: Date.now() }
}
