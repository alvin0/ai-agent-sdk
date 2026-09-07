'use client'

/**
 * Three-column shell: sidebar | conversation | details.
 *
 * The details track exists from first paint at width 0 (its subtree stays
 * mounted, as in the source harness) and the sidebar collapses to a rail on a
 * narrow viewport. The sidebar edge is draggable.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { ConversationRow, GroupRow } from '@chat-agents/backend'
import {
  IconChevronDownOutline14, IconDarkOutline16, IconFolderOpen16, IconLightOutline16,
  IconNewChatOutline16, IconPanelLeftOutline16, IconPlusOutline16, IconSettingsOutline16,
  IconTrashOutline16, Menu, relativeTime,
} from '../primitives'
import css from './AppShell.module.css'

const SIDEBAR_DEFAULT = 268
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 420
const RAIL = 52
const AUTO_COLLAPSE = 900

function clamp(value: number): number {
  return Math.min(Math.max(value, SIDEBAR_MIN), SIDEBAR_MAX)
}

/** Relative time for a unix-seconds timestamp. */
function when(seconds: number): string {
  const { unit, n } = relativeTime(seconds * 1000, Date.now())
  if (unit === 'now') return 'just now'
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-n, unit)
}

export interface AppShellProps {
  children: ReactNode
  conversations: readonly ConversationRow[]
  groups: readonly GroupRow[]
  /** The open group; its workspace, agents, MCP servers, and skills are in play. */
  groupId: string
  onOpenGroup: (id: string) => void
  /** Open the project dialog: switch project, or pick a folder to add one. */
  onManageProjects: () => void
  currentId: string
  onNewChat: () => void
  onOpenConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onOpenSettings: () => void
  /** Current provider/model, shown on the picker button. */
  modelLabel: string
  dark: boolean
  onToggleTheme: () => void
}

/**
 * Render the shell.
 * @param props - Conversation column plus the sidebar's data and actions.
 * @returns The full-height application frame.
 */
export function AppShell({
  children,
  conversations,
  groups,
  groupId,
  onOpenGroup,
  onManageProjects,
  currentId,
  onNewChat,
  onOpenConversation,
  onDeleteConversation,
  onOpenSettings,
  modelLabel,
  dark,
  onToggleTheme,
}: AppShellProps) {
  const [groupMenu, setGroupMenu] = useState(false)
  const [width, setWidth] = useState(SIDEBAR_DEFAULT)
  const [collapsed, setCollapsed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const base = useRef(SIDEBAR_DEFAULT)
  const origin = useRef(0)

  useEffect(() => {
    const onResize = () => { setCollapsed(window.innerWidth < AUTO_COLLAPSE) }
    onResize()
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  const sidebar = collapsed ? RAIL : width

  return (
    <div
      className={css.frame}
      style={{ gridTemplateColumns: `${String(sidebar)}px minmax(0, 1fr) 0px` }}
      data-sidebar-collapsed={collapsed || undefined}
      data-dragging={dragging || undefined}
    >
      <aside className={css.sidebarCol}>
        <div className={css.sidebarHead}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => { setCollapsed(value => !value) }}
          >
            <IconPanelLeftOutline16 />
          </button>
          {!collapsed && <span className={css.brand}>Chat Agents</span>}
          <button type="button" className={css.iconButton} aria-label="New chat" onClick={onNewChat}>
            <IconNewChatOutline16 />
          </button>
        </div>

        {!collapsed && (
          <div className={css.groupRow}>
            <Menu
              open={groupMenu}
              onClose={() => { setGroupMenu(false) }}
              selectedId={groupId}
              className={css.groupMenu}
              items={groups.map(group => ({
                id: group.id,
                label: group.name,
                icon: <IconFolderOpen16 />,
              }))}
              footer={[{ id: '__manage', label: 'Open a folder…', icon: <IconPlusOutline16 /> }]}
              onSelect={(id) => {
                setGroupMenu(false)
                if (id === '__manage') onManageProjects()
                else onOpenGroup(id)
              }}
              anchor={(
                <button
                  type="button"
                  className={css.groupButton}
                  onClick={() => { setGroupMenu(value => !value) }}
                >
                  <IconFolderOpen16 />
                  <span className={css.groupName}>
                    {groups.find(group => group.id === groupId)?.name ?? 'Group'}
                  </span>
                  <IconChevronDownOutline14 />
                </button>
              )}
            />
          </div>
        )}

        {!collapsed && (
          <div className={css.sidebarBody}>
            <span className={css.sectionLabel}>Conversations</span>
            <ul className={css.conversationList}>
              {conversations.length === 0 && <li className={css.empty}>No conversations yet</li>}
              {conversations.map(conversation => (
                <li key={conversation.id}>
                  <div
                    className={clsx(css.conversation, conversation.id === currentId && css.conversationActive)}
                  >
                    <button
                      type="button"
                      className={css.conversationOpen}
                      onClick={() => { onOpenConversation(conversation.id) }}
                    >
                      <span className={css.conversationTitle}>{conversation.title}</span>
                      <span className={css.conversationMeta}>
                        {when(conversation.updatedAt)}
                        {conversation.model === null ? '' : ` · ${conversation.model}`}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={css.conversationDelete}
                      aria-label={`Delete ${conversation.title}`}
                      onClick={() => { onDeleteConversation(conversation.id) }}
                    >
                      <IconTrashOutline16 />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer actions sit at the RIGHT edge: the bottom-left corner is
            where dev tooling overlays park their badge. */}
        <div className={css.sidebarFoot}>
          {!collapsed && <span className={css.footNote}>{modelLabel}</span>}
          <button
            type="button"
            className={css.iconButton}
            aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={onToggleTheme}
          >
            {dark ? <IconLightOutline16 /> : <IconDarkOutline16 />}
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <IconSettingsOutline16 />
          </button>
        </div>
      </aside>

      <div className={css.centerCol}>{children}</div>
      <div className={css.detailsCol} />

      {!collapsed && (
        <div
          className={css.handle}
          style={{ left: sidebar }}
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            base.current = width
            origin.current = event.clientX
            setDragging(true)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            setWidth(clamp(base.current + (event.clientX - origin.current)))
          }}
          onPointerUp={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            event.currentTarget.releasePointerCapture(event.pointerId)
            setDragging(false)
          }}
        />
      )}
    </div>
  )
}
