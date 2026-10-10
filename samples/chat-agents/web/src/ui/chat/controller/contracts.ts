export type { LiveRun } from './run-types'
import type { LiveRun } from './run-types'
import type { Dispatch, SetStateAction, RefObject } from 'react'
import type {
  ConversationRow, GroupRow, GroupView, WireApprovalScope, WireAttachment,
} from '@chat-agents/backend'
import type { ChatNode, ChatState } from '../types'

export interface ChatController extends ChatState {
  /** The open conversation; empty until the first client render resolves it. */
  readonly sessionId: string
  /** Conversations with a run in flight, this one or any other. */
  readonly runningIds: readonly string[]
  readonly conversations: readonly ConversationRow[]
  readonly groups: readonly GroupView[]
  /** The open group; conversations and tools are scoped to it. */
  readonly groupId: string
  openGroup: (id: string) => void
  /** Create a project from a folder; its name defaults to the folder name. */
  createGroup: (workspaceRoot: string) => Promise<GroupRow | undefined>
  deleteGroup: (id: string) => Promise<void>
  /** Show a project's folder in the desktop file manager. */
  revealGroup: (id: string) => Promise<void>
  refreshGroups: () => Promise<void>
  /**
   * Start a turn.
   * @param prompt - What the user typed; may be empty when files carry it.
   * @param attachments - Records for the message row, in pick order.
   */
  send: (prompt: string, attachments?: readonly WireAttachment[],
  /** Skill ids attached as chips, outside the message text. */
  skillIds?: readonly string[]) => Promise<void>
  answer: (requestId: string, answers: Record<string, string>) => Promise<void>
  /** Add a message to the run in flight, instead of waiting for it to end. */
  steer: (prompt: string, skillIds?: readonly string[]) => Promise<void>
  /** Answer a parked permission prompt; `scope` decides how long it lasts. */
  approve: (callId: string, decision: 'allow' | 'deny', scope: WireApprovalScope, ruleKey?: string) => Promise<void>
  stop: () => void
  newConversation: () => void
  openConversation: (id: string) => void
  removeConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  refreshConversations: () => Promise<void>
}

export interface ControllerContext {
  sessionId: string
  groupId: string
  state: ChatState
  setState: Dispatch<SetStateAction<ChatState>>
  setSessionId: Dispatch<SetStateAction<string>>
  setGroupId: Dispatch<SetStateAction<string>>
  setConversations: Dispatch<SetStateAction<readonly ConversationRow[]>>
  setGroups: Dispatch<SetStateAction<readonly GroupView[]>>
  setRunningIds: Dispatch<SetStateAction<readonly string[]>>
  runs: RefObject<Map<string, LiveRun>>
  shown: RefObject<string>
  answered: RefObject<Set<string>>
}

export type EditNodes = (id: string, edit: (nodes: readonly ChatNode[]) => readonly ChatNode[]) => void
