import { useRef, useState } from 'react'
import type { ConversationRow, GroupView } from '@chat-agents/backend'
import type { ChatState } from '../types'
import type { ControllerContext, LiveRun } from './contracts'

export function useChatState() {
  const [sessionId, setSessionId] = useState('')
  const [conversations, setConversations] = useState<readonly ConversationRow[]>([])
  const [groups, setGroups] = useState<readonly GroupView[]>([])
  const [groupId, setGroupId] = useState('')
  const [state, setState] = useState<ChatState>({
    nodes: [],
    running: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    progress: null,
    members: [],
    spans: [],
    runId: '',
  })
  // A run belongs to its conversation and continues when another view is open.
  const runs = useRef(new Map<string, LiveRun>())
  // Stream closures read the current view through this ref, rather than stale state.
  const shown = useRef('')
  const [runningIds, setRunningIds] = useState<readonly string[]>([])
  // Successful decisions are sent once; failed decisions remove their entry for retry.
  const answered = useRef(new Set<string>())
  const context: ControllerContext = {
    sessionId, groupId, state, setState, setSessionId, setGroupId, setConversations,
    setGroups, setRunningIds, runs, shown, answered,
  }
  return { context, conversations, groups, runningIds }
}
