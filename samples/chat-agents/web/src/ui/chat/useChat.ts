'use client'

import { useChatState } from './controller/state'
import type { ChatController } from './controller/contracts'
import {
  useRefreshConversations, useRefreshGroups, useInitializeConversation,
  useConversationRefreshEffect, useMirrorGroup,
} from './controller/catalog'
import { useSend } from './controller/send'
import { useEditNodes } from './controller/edits'
import { useAnswer, useApprove, useSteer, useStop } from './controller/controls'
import {
  useApplyConversation, useOpenConversation, useNewConversation, useHistoryNavigation,
} from './controller/navigation'
import { useRemoveConversation, useRenameConversation } from './controller/conversation-actions'
import { useOpenGroup, useCreateGroup, useDeleteGroup, useRevealGroup } from './controller/group-actions'
import { useTranscript, useCacheTranscript } from './controller/transcript'

export type { ChatController } from './controller/contracts'

/** Compose transport, transcript persistence, navigation, and interactive controls. */
export function useChat(): ChatController {
  const { context, conversations, groups, runningIds } = useChatState()
  const { state, sessionId, groupId } = context
  const refreshConversations = useRefreshConversations(context)
  const refreshGroups = useRefreshGroups(context)
  const send = useSend(context, refreshConversations)
  const editNodes = useEditNodes(context)
  const answer = useAnswer(context)
  const approve = useApprove(context, editNodes)
  const steer = useSteer(context, send, editNodes)
  const stop = useStop(context)
  const applyConversation = useApplyConversation(context)
  const openConversation = useOpenConversation(context, applyConversation)
  const newConversation = useNewConversation(context, openConversation)
  const removeConversation = useRemoveConversation(context, openConversation, refreshConversations)
  const renameConversation = useRenameConversation(context, refreshConversations)
  const openGroup = useOpenGroup(context)
  const createGroup = useCreateGroup(context, openGroup, refreshGroups)
  const deleteGroup = useDeleteGroup(context, refreshGroups)
  const revealGroup = useRevealGroup(context)
  useInitializeConversation(context, refreshGroups)
  useConversationRefreshEffect(context, refreshConversations)
  useMirrorGroup(context)
  useTranscript(context)
  useCacheTranscript(context)
  useHistoryNavigation(context, applyConversation)
  return {
    ...state,
    sessionId,
    runningIds,
    conversations,
    groups,
    groupId,
    openGroup,
    createGroup,
    deleteGroup,
    revealGroup,
    refreshGroups,
    send,
    answer,
    steer,
    approve,
    stop,
    newConversation,
    openConversation,
    removeConversation,
    renameConversation,
    refreshConversations,
  }
}
