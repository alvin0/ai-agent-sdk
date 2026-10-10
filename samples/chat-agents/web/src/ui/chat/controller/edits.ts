import { useCallback } from 'react'
import type { ChatNode } from '../types'
import type { ControllerContext } from './contracts'

export function useEditNodes(context: ControllerContext) {
  const { runs, shown, setState } = context
  const editNodes = useCallback((id: string, edit: (nodes: readonly ChatNode[]) => readonly ChatNode[]) => {
    const live = runs.current.get(id)
    if (live !== undefined)
      live.nodes = edit(live.nodes)
    if (shown.current !== id)
      return
    setState(previous => ({ ...previous, nodes: live === undefined ? edit(previous.nodes) : live.nodes }))
  }, [])
  return editNodes
}
