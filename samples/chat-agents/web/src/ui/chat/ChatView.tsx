'use client'

/**
 * The transcript column: the message list, its stick-to-bottom behaviour, and
 * the composer under it.
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconFolderOpen16, IconLoadingOutline16, IconSendOutline16, IconStopFill16,
  IconThinkOutline14, IconWarningOutline16, MarkdownText, projectUserText, StateDot,
} from '../primitives'
import { markdownLabels } from '../labels'
import { ApprovalCard, ApprovalRecord } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { TeamRoster } from './TeamRoster'
import { ToolNode } from './ToolNode'
import { ComposerControls } from './ComposerControls'
import type { SettingsController } from '../settings/useSettings'
import type { ChatController } from './useChat'
import type { ChatNode, MemberState } from './types'
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

/**
 * The run's live status line.
 *
 * Its own component because of the clock: a counter that only moved when the
 * server spoke would sit frozen between reports, and a frozen number next to a
 * spinner reads as a stalled app. The server says WHAT is happening; the
 * elapsed time is counted here, once a second, for as long as the run lasts.
 */
function RunningHint({ label }: { label: string | null }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const tick = setInterval(() => {
      setSeconds(Math.round((Date.now() - started) / 1000))
    }, 1_000)
    return () => { clearInterval(tick) }
  }, [])
  const elapsed = seconds < 90
    ? `${String(seconds)}s`
    : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
  return (
    <div className={css.runningHint}>
      <IconLoadingOutline16 className={css.runningSpinner} />
      <span className={css.runningLabel}>{label ?? 'Working'}</span>
      <span className={css.runningElapsed}>{elapsed}</span>
      <span className={css.runningAside}>type to steer, or stop it</span>
    </div>
  )
}

/** One run of consecutive rows from the same author. */
interface Block {
  /** The team member who produced them; absent means the agent you talk to. */
  readonly member: string | undefined
  readonly nodes: readonly ChatNode[]
}

/**
 * Split the transcript into consecutive same-author blocks.
 *
 * A per-row badge was not enough to read a team run: a member's work appeared
 * at the same level as the lead's, so the transcript looked like one agent
 * talking to itself. Grouping lets a member's stretch be drawn as one labelled,
 * indented block — the shape that says "this part is not the lead".
 * @param nodes - The transcript, in order.
 * @returns Blocks in the same order.
 */
function blocksOf(nodes: readonly ChatNode[]): readonly Block[] {
  const blocks: Block[] = []
  for (const node of nodes) {
    const member = 'member' in node ? node.member : undefined
    const last = blocks[blocks.length - 1]
    if (last !== undefined && last.member === member) (last.nodes as ChatNode[]).push(node)
    else blocks.push({ member, nodes: [node] })
  }
  return blocks
}

/**
 * Render one block of rows.
 *
 * A member's block is drawn as a named, indented panel; the lead's rows are
 * drawn plainly, so the transcript's top level always reads as the agent the
 * user is talking to.
 * @param props - The block, the member's live status, and the answer callback.
 * @returns The rows, wrapped for a member.
 */
function BlockView({
  block,
  status,
  onAnswer,
}: {
  block: Block
  status: MemberState['status'] | undefined
  onAnswer: (requestId: string, answers: Record<string, string>) => void
}) {
  const rows = block.nodes.map(node => (
    <div className={css.row} key={`${node.kind}-${node.id}`}>
      <NodeView node={node} onAnswer={onAnswer} />
    </div>
  ))
  if (block.member === undefined) return <>{rows}</>
  return (
    <section className={css.memberBlock} aria-label={`${block.member}'s work`}>
      <header className={css.memberHeader}>
        <StateDot state={status === 'running' ? 'ongoing' : status === 'done' ? 'done' : 'warning'} />
        <span className={css.memberName}>{block.member}</span>
        <span className={css.memberRole}>subagent</span>
      </header>
      <div className={css.memberRows}>{rows}</div>
    </section>
  )
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
          <MarkdownText text={node.text} streaming={node.streaming} labels={markdownLabels} />
        </div>
      )
    case 'reasoning':
      return <ReasoningRow node={node} />
    case 'tool':
      return <ToolNode node={node} />
    case 'question':
      return <QuestionCard node={node} onSubmit={onAnswer} />
    /**
     * A prompt still parked is drawn over the composer, not here: the
     * transcript keeps only the record of what was decided.
     */
    case 'approval':
      return <ApprovalRecord node={node} />
    case 'notice':
      return (
        <div className={css.notice} data-level={node.level}>
          <IconWarningOutline16 />
          {node.message}
        </div>
      )
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

  // Typing during a run steers it rather than queueing behind it: the message
  // joins the agent's history and its next model round reads it, so a wrong
  // turn is corrected without stopping and re-prompting.
  const submit = () => {
    const text = draft.trim()
    if (text === '') return
    setDraft('')
    void (chat.running ? chat.steer(text) : chat.send(text))
  }

  const blocks = blocksOf(chat.nodes.filter(node => focusedMember === null
    || ('member' in node && node.member === focusedMember)))

  // At most one prompt is shown at a time: the calls in a batch are parked
  // independently, and answering them one by one is what the user can follow.
  const parked = chat.nodes.find(
    (node): node is Extract<ChatNode, { kind: 'approval' }> =>
      node.kind === 'approval' && node.decision === undefined,
  )

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
              <h1 className={css.emptyTitle}>Work in this workspace</h1>
              <p className={css.emptyHint}>
                The agent can read and search files, publish a todo list, and stop to ask you a
                question when a decision is yours. Writing, deleting, and running commands ask
                your permission first — once, for this chat, or for the whole project.
              </p>
            </div>
          )}
          {blocks.map(block => (
            <BlockView
              key={`${block.member ?? 'lead'}-${block.nodes[0]?.kind ?? ''}-${block.nodes[0]?.id ?? ''}`}
              block={block}
              status={block.member === undefined
                ? undefined
                : chat.members.find(member => member.name === block.member)?.status}
              onAnswer={(requestId, answers) => { void chat.answer(requestId, answers) }}
            />
          ))}
          {/*
            The live status belongs at the END of the stream, where the next
            thing to appear will be — the same place Claude Code and Codex put
            it. Below the composer it read as chrome about the input box rather
            than as the run's own last line.
          */}
          {chat.running && <RunningHint label={chat.progress} />}
          <div ref={bottom} />
        </div>
      </div>

      {parked !== undefined && (
        <ApprovalCard
          key={parked.callId}
          node={parked}
          onDecide={(callId, decision, scope) => { void chat.approve(callId, decision, scope) }}
        />
      )}

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
            placeholder={chat.running
              ? 'Steer the agent — it reads this on its next step…'
              : 'Ask anything about the workspace…'}
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
            {/*
              One button, never two. While a run is going it is Stop, because
              that is the action a button is needed for; steering is sent with
              Enter, which is what the placeholder tells you to do.
            */}
            {/*
              One button, and its meaning follows the draft. Empty during a run
              it stops the run; the moment you type, it becomes send, which is
              how you learn that steering a run in flight is possible at all.
              Clear the box to get stop back.
            */}
            {chat.running && draft.trim() === ''
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
                  aria-label={chat.running ? 'Steer' : 'Send'}
                >
                  <IconSendOutline16 />
                </button>
              )}
          </div>
        </div>
      </div>
    </div>
  )
}
