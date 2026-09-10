'use client'

/**
 * Two-column shell: sidebar | conversation.
 *
 * Same frame as the chat-agents sample, minus the details track and the
 * projects section — an Edge deployment has no workspace to scope a project
 * to, so a project list here would name nothing. The sidebar collapses to a
 * rail on a narrow viewport and its edge is draggable.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConversationRow } from './types'
import css from './AppShell.module.css'

const SIDEBAR_DEFAULT = 268
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 420
const RAIL = 52
const AUTO_COLLAPSE = 900
/** Conversations shown before the list offers "Show more". */
const CHAT_PAGE = 10

function clamp(value: number): number {
  return Math.min(Math.max(value, SIDEBAR_MIN), SIDEBAR_MAX)
}

export interface AppShellProps {
  children: ReactNode
  conversations: readonly ConversationRow[]
  currentId: string
  /** Conversations with a turn in flight, including ones running in background. */
  runningIds: readonly string[]
  onNewChat: () => void
  onOpenConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  /** Current model, shown in the footer. */
  modelLabel: string
  /** True when the browser holds a key of its own. */
  hasKey: boolean
  /** True when neither the browser nor the deployment has a key. */
  needsKey: boolean
  onOpenKey: () => void
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
  currentId,
  runningIds,
  onNewChat,
  onOpenConversation,
  onDeleteConversation,
  modelLabel,
  hasKey,
  needsKey,
  onOpenKey,
  dark,
  onToggleTheme,
}: AppShellProps) {
  const [limit, setLimit] = useState(CHAT_PAGE)
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
      style={{ gridTemplateColumns: `${String(sidebar)}px minmax(0, 1fr)` }}
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
            <PanelIcon />
          </button>
          {!collapsed && <span className={css.brand}>Edge Chat Agents</span>}
        </div>

        {!collapsed && (
          <div className={css.sidebarBody}>
            {/* New chat is a row of its own, at the top, because it is the one
                thing a user does more often than anything else in this column. */}
            <button type="button" className={css.newChat} onClick={onNewChat}>
              <span className={css.rowLabel}>New chat</span>
              <span className={css.newChatPlus} aria-hidden="true">+</span>
            </button>

            <div className={css.sectionLabel}>Conversations</div>
            <ul className={css.rows}>
              {conversations.length === 0 && <li className={css.empty}>No conversations yet</li>}
              {conversations.slice(0, limit).map(row => (
                <li key={row.id} className={css.rowWrap}>
                  <button
                    type="button"
                    className={row.id === currentId ? `${css.row} ${css.rowActive}` : css.row}
                    onClick={() => { onOpenConversation(row.id) }}
                  >
                    {/* A run outlives the view of it, so the list is where you
                        find out a conversation is still working. */}
                    {runningIds.includes(row.id) && <span className={css.rowDot} aria-hidden="true" />}
                    <span className={css.rowLabel}>{row.title}</span>
                  </button>
                  <button
                    type="button"
                    className={css.rowAction}
                    aria-label={`Delete ${row.title}`}
                    onClick={() => { onDeleteConversation(row.id) }}
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
              {conversations.length > limit && (
                <li>
                  <button
                    type="button"
                    className={`${css.row} ${css.more}`}
                    onClick={() => { setLimit(count => count + CHAT_PAGE) }}
                  >
                    Show more
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}

        <div className={css.sidebarFoot}>
          {!collapsed && <span className={css.footNote}>{modelLabel}</span>}
          {/* The key button carries a dot when nothing can run without one:
              a run that fails for a missing credential should have been
              preventable from the chrome, not only from an error message. */}
          <button
            type="button"
            className={css.iconButton}
            aria-label={hasKey ? 'Change API key' : 'Add an API key'}
            title={hasKey ? 'API key stored in this browser' : 'Add an API key'}
            data-attention={needsKey || undefined}
            onClick={onOpenKey}
          >
            <KeyIcon />
            {needsKey && <span className={css.badge} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={onToggleTheme}
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </aside>

      <div className={css.centerCol}>{children}</div>

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

/* The icons are inline so the sample ships no icon dependency: five glyphs do
   not justify a package, and each one is a single path. */

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function KeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="3.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="m8.3 8.3 4.4 4.4M11 10.6l1.4 1.4M9.6 12l1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2 3.1 3.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}
