'use client'

/**
 * The transcript column: the message list, its stick-to-bottom behaviour, and
 * the composer under it.
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconFolderOpen16, IconLoadingOutline16, IconSendOutline16, IconStopFill16,
  IconThinkOutline14, MarkdownText, projectUserText,
} from '../primitives'
import { markdownLabels } from '../labels'
import { QuestionCard } from './QuestionCard'
import { TeamRoster } from './TeamRoster'
import { ToolNode } from './ToolNode'
import { ComposerControls } from './ComposerControls'
import type { SettingsController } from '../settings/useSettings'
import type { ChatController } from './useChat'
import type { ChatNode } from './types'
import css from './ChatView.module.css'

function ReasoningRow({ node }: { node: Extract<ChatNode, { kind: 'reasoning' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={css.reasoning}>
      <button type="button" className={css.reasoningToggle} onClick={() => { setOpen(value => !value) }}>
        <IconThinkOutline14 />
        {open ? 'Hide reasoning' : 'Reasoning'}
      </button>
      {open && <div className={css.reasoningBody}>{node.text}</div>}
    </div>
  )
}

/** Rows produced by a team member are labelled with who wrote them. */
function MemberBadge({ member }: { member: string | undefined }) {
  if (member === undefined) return null
  return <span className={css.memberBadge}>{member}</span>
}

function NodeView({
  node,
  onAnswer,
}: {
  node: ChatNode
  onAnswer: (requestId: string, answers: Record<string, string>) => void
}) {
  switch (node.kind) {
    case 'user':
      return <div className={css.userMessage}>{projectUserText(node.text, [])}</div>
    case 'text':
      return (
        <div className={clsx(css.assistant, node.phase === 'commentary' && css.commentary)}>
          <MemberBadge member={node.member} />
          <MarkdownText text={node.text} streaming={node.streaming} labels={markdownLabels} />
        </div>
      )
    case 'reasoning':
      return <ReasoningRow node={node} />
    case 'tool':
      return (
        <>
          <MemberBadge member={node.member} />
          <ToolNode node={node} />
        </>
      )
    case 'question':
      return <QuestionCard node={node} onSubmit={onAnswer} />
    case 'error':
      return <div className={css.error}>{node.message}</div>
    default:
      return null
  }
}

export interface ChatViewProps {
  chat: ChatController
  /** Model, effort, and loop-mode controls rendered on the composer bar. */
  settings: SettingsController
  /** Conversation title shown in the column header. */
  title: string
  /** Effective provider/model for the next run. */
  modelLabel: string
  /** Directory the agent's tools are confined to. */
  workspace: string
  onOpenSettings: () => void
}

/**
 * Render the transcript and the composer.
 * @param props - Chat controller plus the header's context.
 * @returns The centre column.
 */
export function ChatView({ chat, settings, title, modelLabel, workspace, onOpenSettings }: ChatViewProps) {
  const [draft, setDraft] = useState('')
  const [focusedMember, setFocusedMember] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)

  // Stick to the bottom only while the reader is already there, so scrolling
  // back through a long run is not fought by every incoming delta.
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const onScroll = () => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => { element.removeEventListener('scroll', onScroll) }
  }, [])

  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [chat.nodes])

  const submit = () => {
    const text = draft.trim()
    if (text === '' || chat.running) return
    setDraft('')
    void chat.send(text)
  }

  return (
    <div className={css.column}>
      <header className={css.header}>
        <span className={css.headerTitle}>{title}</span>
        <div className={css.headerMeta}>
          <button type="button" className={css.chip} onClick={onOpenSettings} title={workspace}>
            <IconFolderOpen16 />
            <span className={css.chipText}>{workspace.split('/').slice(-1)[0] || workspace}</span>
          </button>
        </div>
      </header>

      <div className={css.scroller} ref={scroller}>
        <div className={css.thread}>
          {chat.nodes.length === 0 && (
            <div className={css.empty}>
              <h1 className={css.emptyTitle}>Ask about this workspace</h1>
              <p className={css.emptyHint}>
                The agent can read files, search, propose diffs, publish a todo list, and stop to
                ask you a question when a decision is yours.
              </p>
            </div>
          )}
          {chat.nodes
            .filter(node => focusedMember === null
              || ('member' in node && node.member === focusedMember))
            .map(node => (
              <div className={css.row} key={`${node.kind}-${node.id}`}>
                <NodeView
                  node={node}
                  onAnswer={(requestId, answers) => { void chat.answer(requestId, answers) }}
                />
              </div>
            ))}
          <div ref={bottom} />
        </div>
      </div>

      <div className={css.composerWrap}>
        <div className={css.composerInner}>
          <TeamRoster
            members={chat.members}
            focused={focusedMember}
            onFocus={setFocusedMember}
          />
        </div>
        <div className={css.composer}>
          <textarea
            className={css.input}
            value={draft}
            rows={1}
            placeholder="Ask anything about the workspace…"
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <div className={css.composerActions}>
            <ComposerControls settings={settings} />
            <span className={css.usage}>
              {chat.usage.inputTokens + chat.usage.outputTokens > 0 && (
                `${String(chat.usage.inputTokens)} in · ${String(chat.usage.outputTokens)} out`
              )}
            </span>
            {chat.running
              ? (
                <button type="button" className={clsx(css.send, css.stop)} onClick={chat.stop} aria-label="Stop">
                  <IconStopFill16 />
                </button>
              )
              : (
                <button
                  type="button"
                  className={css.send}
                  onClick={submit}
                  disabled={draft.trim() === ''}
                  aria-label="Send"
                >
                  <IconSendOutline16 />
                </button>
              )}
          </div>
        </div>
        {chat.running && (
          <div className={css.runningHint}>
            <IconLoadingOutline16 />
            Working…
          </div>
        )}
      </div>
    </div>
  )
}
