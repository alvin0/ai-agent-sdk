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
import type { ConversationRow, GroupView } from '@chat-agents/backend'
import {
  IconChevronDownOutline14, IconDarkOutline16, IconEditOutline16, IconEllipsisOutline16,
  IconFolderClose16, IconFolderOpen16, IconLightOutline16, IconNewChatOutline16,
  IconPanelLeftOutline16, IconPlusOutline16, IconSettingsOutline16, IconTrashOutline16,
  Menu, StateDot,
} from '../primitives'
import css from './AppShell.module.css'

/**
 * How many rows a list shows before it offers "Show more".
 *
 * A sidebar that scrolls for a hundred conversations is a sidebar nobody reads
 * the bottom of, and the recent ones are the ones being worked on.
 */
const CHAT_PAGE = 8
const PROJECT_PAGE = 6

const SIDEBAR_DEFAULT = 268
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 420
const RAIL = 52
const AUTO_COLLAPSE = 900

function clamp(value: number): number {
  return Math.min(Math.max(value, SIDEBAR_MIN), SIDEBAR_MAX)
}

/**
 * One folding group of sidebar rows.
 *
 * The header is the whole affordance: its label folds the group, and the one
 * optional action sits at the far edge where the eye already is after reading
 * the label. Rows come from the caller because a project row and a chat row
 * carry different trailing information — a count against a timestamp — and
 * flattening both into one shape would lose that.
 * @param props - Label, fold state, optional trailing action, and the rows.
 * @returns The section.
 */
function SidebarSection({
  label,
  folded,
  onFold,
  action,
  children,
}: {
  label: string
  folded: boolean
  onFold: () => void
  action?: { label: string; icon: ReactNode; onClick: () => void }
  children: ReactNode
}) {
  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <button
          type="button"
          className={css.sectionToggle}
          aria-expanded={!folded}
          onClick={onFold}
        >
          <IconChevronDownOutline14
            className={clsx(css.sectionChevron, folded && css.sectionChevronFolded)}
          />
          <span className={css.sectionLabel}>{label}</span>
        </button>
        {action !== undefined && (
          <button
            type="button"
            className={css.sectionAction}
            aria-label={action.label}
            title={action.label}
            onClick={action.onClick}
          >
            {action.icon}
          </button>
        )}
      </div>
      {!folded && <ul className={css.rows}>{children}</ul>}
    </section>
  )
}

export interface AppShellProps {
  children: ReactNode
  conversations: readonly ConversationRow[]
  groups: readonly GroupView[]
  /** The open group; its workspace, agents, MCP servers, and skills are in play. */
  groupId: string
  onOpenGroup: (id: string) => void
  /** Open the project dialog: switch project, or pick a folder to add one. */
  onManageProjects: () => void
  /** Open one project's own settings, without switching to it first. */
  onEditProject: (id: string) => void
  /** Show a project's folder in the desktop file manager. */
  onRevealProject: (id: string) => void
  /**
   * Drop a project from the list.
   *
   * The folder is untouched: this deletes the project row and its per-project
   * presets, and moves its conversations back to the default project.
   */
  onDeleteProject: (id: string) => void
  currentId: string
  /** Conversations with a run in flight, including ones not on screen. */
  runningIds: readonly string[]
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
  runningIds,
  onOpenGroup,
  onManageProjects,
  onEditProject,
  onRevealProject,
  onDeleteProject,
  currentId,
  onNewChat,
  onOpenConversation,
  onDeleteConversation,
  onOpenSettings,
  modelLabel,
  dark,
  onToggleTheme,
}: AppShellProps) {
  /**
   * Which sections are folded away.
   *
   * A project list and a chat list compete for the same column, and which one
   * matters depends on the moment — so both fold, and neither is given a
   * permanent share of the height.
   */
  const [folded, setFolded] = useState<Readonly<Record<'projects' | 'chats', boolean>>>({
    projects: false,
    chats: false,
  })
  const fold = (section: 'projects' | 'chats') => () => {
    setFolded(current => ({ ...current, [section]: !current[section] }))
  }
  /** The project row whose "…" menu is open. */
  const [projectMenu, setProjectMenu] = useState<string | undefined>(undefined)
  /**
   * The project whose removal has been asked for once.
   *
   * Removing drops the project's own presets and moves its conversations back
   * to the default project, and none of that is undoable — so the row asks a
   * second time rather than acting on the first click, the same two-step the
   * usage pane uses for clearing history.
   */
  const [confirmRemove, setConfirmRemove] = useState<string | undefined>(undefined)
  const [chatLimit, setChatLimit] = useState(CHAT_PAGE)
  // A limit the user raised belonged to the project they raised it in; carrying
  // it into the next one would expand a list they never asked to see.
  useEffect(() => { setChatLimit(CHAT_PAGE) }, [groupId])
  const [projectLimit, setProjectLimit] = useState(PROJECT_PAGE)
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
        </div>

        {!collapsed && (
          <div className={css.sidebarBody}>
            {/*
              New chat is a row of its own, at the top, because it is the one
              thing a user does more often than anything else in this column.
              As an icon in the header it was a 28px target sharing a line with
              two other icons, identifiable only by hovering it.
            */}
            <button type="button" className={css.newChat} onClick={onNewChat}>
              <IconNewChatOutline16 className={css.rowIcon} />
              <span className={css.rowLabel}>New chat</span>
              <span className={css.newChatPlus} aria-hidden="true"><IconPlusOutline16 /></span>
            </button>

            {/*
              Projects are LISTED, not hidden behind a picker, and the open
              project's conversations hang UNDER it: a conversation belongs to
              exactly one project, and two flat lists made the reader join them
              up by inference. Only the open project can expand — it is the only
              one whose conversations the browser holds.
            */}
            <SidebarSection
              label="Projects"
              folded={folded.projects}
              onFold={fold('projects')}
              action={{ label: 'Open a folder…', icon: <IconPlusOutline16 />, onClick: onManageProjects }}
            >
              {groups.slice(0, projectLimit).map((group) => {
                const open = group.id === groupId
                return (
                  <li key={group.id}>
                    <div className={css.rowWrap}>
                      <button
                        type="button"
                        className={clsx(css.row, open && css.rowActive)}
                        onClick={() => {
                          // Clicking the open project folds its chats away
                          // rather than re-opening what is already open.
                          if (open) fold('chats')()
                          else onOpenGroup(group.id)
                        }}
                      >
                        {open && !folded.chats
                          ? <IconFolderOpen16 className={css.rowIcon} />
                          : <IconFolderClose16 className={css.rowIcon} />}
                        <span className={css.rowLabel}>{group.name}</span>
                        {!open && <span className={css.rowCount}>{group.conversations}</span>}
                      </button>
                      {/*
                        Hover actions. The menu keeps them shown while it is
                        open, so the row does not empty out from under the list
                        the moment the pointer moves onto it.
                      */}
                      <span
                        className={clsx(
                          css.rowActions,
                          projectMenu === group.id && css.rowActionsOpen,
                        )}
                      >
                        <button
                          type="button"
                          className={css.rowActionItem}
                          aria-label={`New chat in ${group.name}`}
                          title={`New chat in ${group.name}`}
                          onClick={() => {
                            // Switching project already starts a fresh
                            // conversation, so the two cases differ by one call.
                            if (open) onNewChat()
                            else onOpenGroup(group.id)
                          }}
                        >
                          <IconNewChatOutline16 />
                        </button>
                        <Menu
                          open={projectMenu === group.id}
                          onClose={() => {
                            setProjectMenu(undefined)
                            setConfirmRemove(undefined)
                          }}
                          portal
                          align="end"
                          items={[
                            { id: 'edit', label: 'Edit project', icon: <IconEditOutline16 /> },
                            {
                              id: 'reveal',
                              label: 'Open folder',
                              icon: <IconFolderOpen16 />,
                            },
                            { type: 'separator', id: 's1' },
                            {
                              id: 'remove',
                              label: confirmRemove === group.id
                                ? 'Remove — click to confirm'
                                : 'Remove from list',
                              icon: <IconTrashOutline16 />,
                              danger: true,
                              // The fallback every conversation lands in, so
                              // there is nowhere for its chats to go.
                              disabled: group.id === 'default',
                            },
                          ]}
                          onSelect={(id) => {
                            if (id === 'remove') {
                              // First click arms, second removes.
                              if (confirmRemove !== group.id) {
                                setConfirmRemove(group.id)
                                return
                              }
                              setConfirmRemove(undefined)
                              setProjectMenu(undefined)
                              onDeleteProject(group.id)
                              return
                            }
                            setConfirmRemove(undefined)
                            setProjectMenu(undefined)
                            if (id === 'edit') onEditProject(group.id)
                            else if (id === 'reveal') onRevealProject(group.id)
                          }}
                          anchor={(
                            <button
                              type="button"
                              className={css.rowActionItem}
                              aria-label={`Actions for ${group.name}`}
                              title="More"
                              onClick={() => {
                                setConfirmRemove(undefined)
                                setProjectMenu(current => (current === group.id ? undefined : group.id))
                              }}
                            >
                              <IconEllipsisOutline16 />
                            </button>
                          )}
                        />
                      </span>
                    </div>

                    {open && !folded.chats && (
                      <ul className={css.nested}>
                        {conversations.length === 0 && (
                          <li className={css.empty}>No conversations yet</li>
                        )}
                        {conversations.slice(0, chatLimit).map(conversation => (
                          <li key={conversation.id} className={css.rowWrap}>
                            <button
                              type="button"
                              className={clsx(
                                css.row,
                                css.nestedRow,
                                conversation.id === currentId && css.rowActive,
                              )}
                              onClick={() => { onOpenConversation(conversation.id) }}
                            >
                              {/*
                                A run outlives the view of it, so the list is
                                where you find out that a conversation you
                                walked away from is still working.
                              */}
                              {runningIds.includes(conversation.id) && (
                                <StateDot state="ongoing" className={css.rowDot} />
                              )}
                              <span className={css.rowLabel}>{conversation.title}</span>
                            </button>
                            <button
                              type="button"
                              className={css.rowAction}
                              aria-label={`Delete ${conversation.title}`}
                              onClick={() => { onDeleteConversation(conversation.id) }}
                            >
                              <IconTrashOutline16 />
                            </button>
                          </li>
                        ))}
                        {conversations.length > chatLimit && (
                          <li>
                            <button
                              type="button"
                              className={clsx(css.row, css.nestedRow, css.more)}
                              onClick={() => { setChatLimit(count => count + CHAT_PAGE) }}
                            >
                              Show more
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                )
              })}
              {groups.length > projectLimit && (
                <li>
                  <button
                    type="button"
                    className={clsx(css.row, css.more)}
                    onClick={() => { setProjectLimit(count => count + PROJECT_PAGE) }}
                  >
                    Show more
                  </button>
                </li>
              )}
            </SidebarSection>
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
