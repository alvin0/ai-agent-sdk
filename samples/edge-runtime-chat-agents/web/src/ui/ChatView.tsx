'use client'

/**
 * The conversation column: header, transcript, composer.
 *
 * The stored transcript remains an arrival-ordered stream, while the view folds
 * each turn's reasoning, tool calls, and member activity into Process so the
 * lead's final answer stays easy to find.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { Markdown } from './Markdown'
import { TeamRoster } from './TeamRoster'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconLoadingOutline16,
  IconSendOutline16, IconStopFill16,
} from './primitives'
import type { ChatController } from './useChat'
import type { ChatNode } from './types'
import css from './ChatView.module.css'

/** Prompts offered on an empty conversation, one per capability worth showing. */
const STARTERS: readonly string[] = [
  'What time is it in Ho Chi Minh City right now?',
  'Explain how Server-Sent Events differ from WebSockets.',
  'Read https://hono.dev and summarise what Hono is in five lines.',
]

/** Keep the live run clock moving even when the server is between events. */
function RunningHint() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const tick = setInterval(() => {
      setSeconds(Math.round((Date.now() - started) / 1_000))
    }, 1_000)
    return () => { clearInterval(tick) }
  }, [])
  const elapsed = seconds < 90
    ? `${String(seconds)}s`
    : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
  return (
    <div className={css.runningHint}>
      <IconLoadingOutline16 className={css.runningSpinner} />
      <span>Working</span>
      <span className={css.runningElapsed}>{elapsed}</span>
    </div>
  )
}

export interface ChatViewProps {
  chat: ChatController
  title: string
  /** Where the key in effect comes from, which the header reports. */
  keySource: 'browser' | 'server' | 'none'
  onOpenKey: () => void
  onOpenTrace: () => void
  /** The model, effort and mode chips, rendered onto the composer bar. */
  controls: ReactNode
  /** Opens the fixed-roster editor; absent while Team Auto is selected. */
  onEditTeam?: () => void
}

/**
 * Render the conversation column.
 * @param props - The chat controller, the composer contents, and the key controls.
 * @returns The column.
 */
export function ChatView({
  chat, title, keySource, onOpenKey, onOpenTrace, controls, onEditTeam,
}: ChatViewProps) {
  /** Which member the transcript is filtered to; null shows everyone. */
  const [focused, setFocused] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  /** Whether the reader is at the bottom, which is what makes autoscroll safe. */
  const pinned = useRef(true)
  const leadNames = new Set(chat.members
    .filter(member => member.role === 'lead')
    .map(member => member.name))

  // Autoscroll follows the stream only while the reader has not scrolled up:
  // yanking the view back down mid-read is worse than losing the tail.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null || !pinned.current) return
    element.scrollTop = element.scrollHeight
  }, [chat.nodes])

  useEffect(() => {
    composer.current?.focus()
  }, [chat.conversationId])

  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || chat.running) return
    setDraft('')
    pinned.current = true
    chat.send(text)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends and Shift+Enter breaks the line, which is what a chat
    // composer has trained every user to expect.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <div className={css.column}>
      <header className={css.header}>
        <span className={css.title}>{title}</span>
        <div className={css.headerMeta}>
          <span className={css.chip} title="Runtime of the API route">Edge runtime</span>
          <button type="button" className={css.chipButton} onClick={onOpenTrace}>Trace</button>
          {/* Which key is paying for the run is worth one word in the header:
              the two sources bill different people. */}
          {keySource !== 'none' && (
            <button
              type="button"
              className={css.chipButton}
              title={keySource === 'browser'
                ? 'Using the key stored in this browser'
                : 'Using the key configured on the server'}
              onClick={onOpenKey}
            >
              {keySource === 'browser' ? 'your key' : 'server key'}
            </button>
          )}
        </div>
      </header>

      {keySource === 'none' && (
        <div className={css.banner}>
          <span>No API key yet. Add one to start chatting.</span>
          <button type="button" className={css.bannerAction} onClick={onOpenKey}>Add key</button>
        </div>
      )}

      <div
        className={css.scroller}
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight
          pinned.current = distance < 80
        }}
      >
        <div className={css.thread}>
          {chat.nodes.length === 0 && (
            <div className={css.empty}>
              <h1 className={css.emptyTitle}>Chat on the Edge</h1>
              <p className={css.emptyHint}>
                An agent loop running inside a Next.js Edge route, streamed over Server-Sent
                Events. The transcript is kept in this browser; a cold Edge start only resets
                the model-side history.
              </p>
              <div className={css.starters}>
                {STARTERS.map(prompt => (
                  <button
                    key={prompt}
                    type="button"
                    className={css.starter}
                    onClick={() => { setDraft(prompt); composer.current?.focus() }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
          <TurnList
            nodes={visible(chat.nodes, focused)}
            running={chat.running}
            leadNames={leadNames}
          />
          {chat.running && <RunningHint />}
        </div>
      </div>

      <div className={css.composerWrap}>
        {/* The roster sits outside the composer card, as in the chat-agents
            sample: it describes the run, not the message being written. */}
        <div className={css.rosterSeat}>
          <TeamRoster
            members={chat.members}
            focused={focused}
            onFocus={setFocused}
            {...onEditTeam === undefined ? {} : { onEdit: onEditTeam }}
          />
        </div>
        <div className={css.composer}>
          <textarea
            ref={composer}
            className={css.input}
            value={draft}
            rows={1}
            placeholder="Ask anything. Enter sends, Shift+Enter for a new line."
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={onKeyDown}
          />
          <div className={css.composerActions}>
            <span className={css.usage}>
              {chat.usage === undefined
                ? ''
                : `${String(chat.usage.inputTokens)} in · ${String(chat.usage.outputTokens)} out`}
            </span>
            {controls}
            {/* One button, and its meaning follows the run: Stop while a turn
                is in flight, Send otherwise. Two buttons would leave one of
                them inert most of the time. */}
            {chat.running
              ? (
                <button
                  type="button"
                  className={clsx(css.send, css.stop)}
                  onClick={chat.stop}
                  aria-label="Stop"
                >
                  <IconStopFill16 />
                </button>
              )
              : (
                <button
                  type="button"
                  className={css.send}
                  disabled={draft.trim() === ''}
                  onClick={submit}
                  aria-label="Send"
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

interface Turn {
  readonly prompt: readonly ChatNode[]
  readonly work: readonly ChatNode[]
  readonly result: readonly ChatNode[]
  readonly spanMs: number | undefined
}

/** Render prompts, a collapsible Process trail, and the final answer separately. */
function TurnList({
  nodes,
  running,
  leadNames,
}: {
  nodes: readonly ChatNode[]
  running: boolean
  leadNames: ReadonlySet<string>
}) {
  const turns = turnsOf(nodes, leadNames)
  return turns.map((turn, index) => (
    <TurnView
      key={turn.prompt[0]?.id ?? turn.work[0]?.id ?? turn.result[0]?.id ?? String(index)}
      turn={turn}
      live={running && index === turns.length - 1}
    />
  ))
}

/** One turn, with completed work folded into a compact Process summary. */
function TurnView({ turn, live }: { turn: Turn; live: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = live || (open ?? turn.result.length === 0)
  const steps = turn.work.filter(node => node.kind === 'tool').length
  const agents = new Set(turn.work.flatMap(node => (
    'member' in node && node.member !== undefined ? [node.member] : []
  ))).size

  return (
    <>
      {turn.prompt.map(node => <Node key={node.id} node={node} />)}
      {turn.work.length > 0 && (live
        ? turn.work.map(node => <Node key={node.id} node={node} />)
        : (
          <div className={css.trail}>
            <button
              type="button"
              className={css.trailToggle}
              aria-expanded={expanded}
              onClick={() => { setOpen(!expanded) }}
            >
              {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
              <span className={css.trailLabel}>
                {turn.spanMs === undefined ? 'Process' : `Process · ${formatSpan(turn.spanMs)}`}
              </span>
              {steps > 0 && (
                <span className={css.trailMeta}>
                  {steps === 1 ? '1 step' : `${String(steps)} steps`}
                </span>
              )}
              {agents > 0 && (
                <span className={css.trailMeta}>
                  {agents === 1 ? '1 agent' : `${String(agents)} agents`}
                </span>
              )}
            </button>
            {expanded && (
              <div className={css.trailBody}>
                {turn.work.map(node => <Node key={node.id} node={node} />)}
              </div>
            )}
          </div>
        ))}
      {turn.result.length > 0 && (
        <section className={css.answerBlock} aria-label={live ? 'Response in progress' : 'Final answer'}>
          <div className={css.answerLabel}>{live ? 'Response in progress' : 'Final answer'}</div>
          {turn.result.map(node => <Node key={node.id} node={node} />)}
        </section>
      )}
    </>
  )
}

/** Split a flat transcript into prompt, process work, and trailing lead answer. */
function turnsOf(nodes: readonly ChatNode[], leadNames: ReadonlySet<string>): readonly Turn[] {
  const groups: ChatNode[][] = []
  for (const node of nodes) {
    const previous = groups.at(-1)
    if (previous === undefined || node.kind === 'user') groups.push([node])
    else previous.push(node)
  }
  return groups.map((group) => {
    const head = group[0]?.kind === 'user' ? 1 : 0
    const resultIndexes = answerRegion(group, head, leadNames)
    const stamps = group.map(node => node.at).filter((at): at is number => typeof at === 'number')
    return {
      prompt: group.slice(0, head),
      work: mergeLegacyTextBlocks(group.filter((_node, index) => index >= head && !resultIndexes.has(index))),
      result: mergeLegacyTextBlocks(group.filter((_node, index) => resultIndexes.has(index))),
      spanMs: stamps.length < 2 ? undefined : Math.max(...stamps) - Math.min(...stamps),
    }
  })
}

/**
 * Repair cached rows written before the wire protocol carried block ids.
 *
 * Those rows can contain adjacent lead fragments (or fragments separated only
 * by member lifecycle marks). Once the Process filter removes the marks, the
 * fragments become a column of identical speaker badges. New rows have a
 * blockId and are deliberately left alone because separate blocks are real.
 */
function mergeLegacyTextBlocks(nodes: readonly ChatNode[]): readonly ChatNode[] {
  const merged: ChatNode[] = []
  for (const node of nodes) {
    const previous = merged.at(-1)
    if (
      previous !== undefined
      && (node.kind === 'assistant' || node.kind === 'reasoning')
      && previous.kind === node.kind
      && previous.blockId === undefined
      && node.blockId === undefined
      && previous.member === node.member
    ) {
      merged[merged.length - 1] = {
        ...previous,
        text: previous.text + node.text,
        ...(node.at === undefined ? {} : { at: node.at }),
      }
    } else {
      merged.push(node)
    }
  }
  return merged
}

/**
 * Find the lead's trailing answer while leaving reasoning, workers and real
 * tool work in Process. Closing team tools may sit between two answer blocks.
 */
function answerRegion(
  group: readonly ChatNode[],
  head: number,
  leadNames: ReadonlySet<string>,
): ReadonlySet<number> {
  const closingTools = new Set(['wait_agents', 'list_agents', 'close_agent', 'submit_result'])
  const answer = (node: ChatNode): boolean => node.kind === 'error'
    || (node.kind === 'assistant'
      && (node.member === undefined || leadNames.has(node.member)))
  const indexes = new Set<number>()
  let index = group.length - 1
  for (; index >= head; index--) {
    if (answer(group[index] as ChatNode)) break
  }
  for (; index >= head; index--) {
    const node = group[index] as ChatNode
    if (answer(node)) indexes.add(index)
    else if (node.kind === 'tool' && !closingTools.has(node.name)
      && (node.member === undefined || leadNames.has(node.member))) break
  }
  return indexes
}

/** Human-readable elapsed span used by the Process line. */
function formatSpan(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * The transcript, filtered to one member.
 *
 * The lead's own output stays visible while a peer is focused: without it a
 * delegated stretch reads as a monologue with no reason for existing. Only
 * other members' output is dropped.
 * @param nodes - The whole transcript.
 * @param focused - The member to focus, or null for everyone.
 * @returns The nodes to draw.
 */
function visible(nodes: readonly ChatNode[], focused: string | null): readonly ChatNode[] {
  if (focused === null) return nodes
  return nodes.filter((node) => {
    if (node.kind === 'user') return true
    if (node.kind === 'member-mark') return node.member === focused
    if (node.kind === 'error') return true
    return node.member === undefined || node.member === focused
  })
}

/** One transcript node. */
function Node({ node }: { node: ChatNode }) {
  if (node.kind === 'user') return <div className={css.userMessage}>{node.text}</div>
  if (node.kind === 'member-mark') {
    return (
      <div className={css.memberMark} data-phase={node.phase} data-failed={node.failed}>
        <span className={css.memberMarkName}>{node.member}</span>
        <span className={css.memberMarkPhase}>
          {node.phase === 'start' ? 'started' : node.failed === true ? 'failed' : 'finished'}
        </span>
      </div>
    )
  }
  if (node.kind === 'assistant') {
    return (
      <section className={css.answer} aria-label={node.live ? 'Response in progress' : 'Response'}>
        {node.member !== undefined && <span className={css.speaker}>{node.member}</span>}
        <Markdown text={node.text} />
      </section>
    )
  }
  if (node.kind === 'reasoning') return <Reasoning text={node.text} />
  if (node.kind === 'error') {
    return (
      <div className={css.error}>
        <span className={css.errorMessage}>{node.message}</span>
        {node.detail !== undefined && node.detail !== '' && (
          <span className={css.errorDetail}>{node.detail}</span>
        )}
      </div>
    )
  }
  return <Tool node={node} />
}

/**
 * Reasoning, folded away by default.
 *
 * It is context for an answer, not the answer, so it starts closed and the
 * header says how much there is to open.
 */
function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={css.reasoning}>
      <button
        type="button"
        className={css.reasoningToggle}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.reasoningLabel}>Reasoning</span>
        <span className={css.reasoningCount}>{`${String(text.length)} chars`}</span>
      </button>
      {open && <div className={css.reasoningBody}>{text}</div>}
    </div>
  )
}

/** One tool call, with its arguments available on demand. */
function Tool({ node }: { node: Extract<ChatNode, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const args = node.input === undefined ? '' : JSON.stringify(node.input, null, 2)
  return (
    <div className={css.tool} data-status={node.status}>
      <button
        type="button"
        className={css.toolHead}
        aria-expanded={open}
        disabled={args === ''}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.toolDot} aria-hidden="true" />
        <span className={css.toolName}>{node.name}</span>
        <span className={css.toolFamily}>
          {node.family === 'provider-native' ? 'provider tool' : 'host tool'}
        </span>
        <span className={css.toolStatus}>{node.status}</span>
      </button>
      {open && args !== '' && <pre className={css.toolArgs}><code>{args}</code></pre>}
    </div>
  )
}
