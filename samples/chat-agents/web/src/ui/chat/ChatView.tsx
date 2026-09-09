'use client'

/**
 * The transcript column: the message list, its stick-to-bottom behaviour, and
 * the composer under it.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconFolderOpen16, IconLoadingOutline16,
  IconPaperclipOutline16, IconSendOutline16, IconSettingsOutline16, IconStopFill16,
  IconThinkOutline14,
  IconWarningOutline16, MarkdownText, projectUserText, StateDot,
} from '../primitives'
import { markdownLabels } from '../labels'
import { ApprovalCard, ApprovalRecord } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { TeamRoster } from './TeamRoster'
import { ToolNode } from './ToolNode'
import { ToolGroup } from './ToolGroup'
import { ComposerControls } from './ComposerControls'
import { ComposerAttachments, MessageAttachments } from './Attachments'
import { useAttachments } from './useAttachments'
import {
  MentionHighlights, SkillChips, SkillMenu, useActiveIndex, useSkillCatalogue,
} from './SkillMenu'
import { detachTrigger, matchSkills, mentionRanges, skillTriggerAt } from './mentions'
import type { SkillTrigger } from './mentions'
import type { SkillMention } from '@chat-agents/backend'
import type { SettingsController } from '../settings/useSettings'
import type { ChatController } from './useChat'
import { blocksOf, formatSpan, rosterOf, segmentsOf, turnsOf, withDelegationPrompts } from './turns'
import type { Block, Turn } from './turns'
import type { ChatNode, MemberState } from './types'
import css from './ChatView.module.css'

/** A heading line, bold or hashed, anchored to the start of a line. */
const REASONING_HEADING = /^[ \t]*(?:\*\*(.+?)\*\*|#{1,6}[ \t]+(.+?))[ \t]*$/m

/**
 * The heading a stretch of reasoning opens with.
 *
 * Reasoning arrives as sections, each introduced by a bold one-line summary —
 * "Planning date retrieval method" — and a column of rows all labelled
 * "Reasoning" says nothing about which is worth opening. The FIRST heading is
 * used rather than the newest, so a group that is still growing does not
 * relabel itself every few seconds.
 * @param text - The block's markdown.
 * @returns The heading, or undefined when the block has none.
 */
function reasoningTitle(text: string): string | undefined {
  const heading = REASONING_HEADING.exec(text)
  const found = (heading?.[1] ?? heading?.[2])?.trim()
  return found === undefined || found === '' ? undefined : found
}

/**
 * The same text with its opening heading removed.
 *
 * That heading is already the group's label, and printing it again as the
 * first line of the body is how one thought came to occupy two lines that say
 * the same thing.
 * @param text - The block's markdown.
 * @returns The body, possibly empty when the heading was all there was.
 */
function reasoningBody(text: string): string {
  return text.replace(REASONING_HEADING, '').trim()
}

/**
 * One stretch of thinking, behind one control.
 *
 * Grouped rather than drawn per block because a research turn emits a dozen of
 * them back to back: twelve identical collapsed strips are a wall, and twelve
 * expanded ones bury the tool calls and the answer between them.
 * @param props - The consecutive reasoning rows, in order.
 * @returns The collapsed strip, and its sections while it is open.
 */
function ReasoningGroup({ nodes }: { nodes: readonly Extract<ChatNode, { kind: 'reasoning' }>[] }) {
  const [open, setOpen] = useState(false)
  const first = nodes[0]
  const title = first === undefined ? undefined : reasoningTitle(first.text)
  const sections = nodes.map((node, index) => ({
    id: node.id,
    // Only the first block's heading is the label, so only it is stripped.
    text: index === 0 && title !== undefined ? reasoningBody(node.text) : node.text,
  })).filter(section => section.text !== '')

  return (
    <div className={css.reasoning}>
      <button
        type="button"
        className={css.reasoningToggle}
        aria-expanded={open}
        disabled={sections.length === 0}
        onClick={() => { setOpen(value => !value) }}
      >
        <IconThinkOutline14 />
        <span className={css.reasoningLabel}>{title ?? 'Reasoning'}</span>
        {nodes.length > 1 && <span className={css.reasoningCount}>{nodes.length}</span>}
        {/* Nothing to open when the model wrote only the heading. */}
        {sections.length > 0 && (open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />)}
      </button>
      {open && sections.length > 0 && (
        <div className={css.reasoningBody}>
          {sections.map(section => (
            /*
              Markdown, not preformatted text: the model writes its summaries
              with bold headings and lists, and printing the asterisks is how a
              summary turns into noise.
            */
            <MarkdownText key={section.id} text={section.text} labels={markdownLabels} />
          ))}
        </div>
      )}
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

/**
 * Render one block of rows.
 *
 * A member's block is drawn as a named, indented panel that folds; the lead's
 * rows are drawn plainly, so the transcript's top level always reads as the
 * agent the user is talking to. Folding matters most here: a team run puts
 * four agents' hundred-odd rows into one turn, and expanded they bury both the
 * lead's own thread and each other.
 * @param props - The block, the member's live status, and the answer callback.
 * @returns The rows, wrapped for a member.
 */
function BlockView({
  block,
  status,
  startOpen = false,
  onAnswer,
}: {
  block: Block
  status: MemberState['status'] | undefined
  /** Start expanded whatever the member's status: the view IS its work. */
  startOpen?: boolean
  onAnswer: (requestId: string, answers: Record<string, string>) => void
}) {
  // Open while the member is working, folded once it is done — the same rule
  // the turn itself follows, and `null` is what lets it change on its own
  // until somebody clicks.
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? (startOpen || status === 'running')

  // The index disambiguates the key: a transcript stored before ids were
  // scoped per author can hold two nodes sharing one id, and the thread is
  // append-only, so position is a stable identity.
  const rows = segmentsOf(block.nodes).map((segment, index) => (
    <div
      className={css.row}
      key={segment.kind === 'row'
        ? `${segment.node.kind}-${segment.node.id}-${String(index)}`
        : `${segment.kind}-${segment.nodes[0]?.id ?? ''}-${String(index)}`}
    >
      {segment.kind === 'tools'
        ? <ToolGroup nodes={segment.nodes} />
        : segment.kind === 'reasoning'
          ? <ReasoningGroup nodes={segment.nodes} />
          : <NodeView node={segment.node} onAnswer={onAnswer} />}
    </div>
  ))
  if (block.member === undefined) return <>{rows}</>

  // Steps, and deliberately NOT a duration. A member's rows are handed over in
  // bursts, when the lead next wakes — so their stamps measure when the run
  // delivered the work, not how long the member spent on it, and a panel that
  // said "1s" over forty-two tool calls would be a confident lie.
  const steps = block.nodes.filter(node => node.kind === 'tool').length
  return (
    <section className={css.memberBlock} aria-label={`${block.member}'s work`}>
      <button
        type="button"
        className={css.memberHeader}
        aria-expanded={expanded}
        onClick={() => { setOpen(!expanded) }}
      >
        {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        {/*
          A member with no live status is one whose run is over — a reloaded
          transcript has no roster — so it is finished, not in trouble. Amber
          used to be the fallback, which painted every agent in every stored
          team run as though something had gone wrong with it.
        */}
        <StateDot state={status === 'running' ? 'ongoing' : status === 'idle' ? 'warning' : 'done'} />
        <span className={css.memberName}>{block.member}</span>
        <span className={css.memberRole}>subagent</span>
        {steps > 0 && (
          <span className={css.memberMeta}>
            {steps === 1 ? '1 step' : `${String(steps)} steps`}
          </span>
        )}
      </button>
      {expanded && <div className={css.memberRows}>{rows}</div>}
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
      return (
        <>
          {node.attachments !== undefined && node.attachments.length > 0 && (
            <MessageAttachments items={node.attachments} />
          )}
          {/* An attachment-only message has no bubble: an empty rounded box
              under the picture reads as a rendering failure. */}
          {node.text.trim() !== '' && (
            <div className={css.userMessage}>{projectUserText(node.text, [])}</div>
          )}
          {/* Which skills the `/` mentions actually matched. The message shows
              what was typed; this shows what the backend recognised, which is
              the difference between a skill being loaded and a word being
              ignored. */}
          {node.skills !== undefined && node.skills.length > 0 && (
            <div className={css.userSkills}>
              {node.skills.map(id => <span key={id} className={css.userSkill}>{`/${id}`}</span>)}
            </div>
          )}
        </>
      )
    case 'assignment':
      return (
        <div className={css.assignment}>
          <div className={css.assignmentLabel}>{node.followup ? 'Follow-up task' : 'Task'} from {node.from}</div>
          <div className={css.assignmentText}>{node.text}</div>
        </div>
      )
    case 'text':
      return (
        <div className={clsx(css.assistant, node.phase === 'commentary' && css.commentary)}>
          <MarkdownText text={node.text} streaming={node.streaming} labels={markdownLabels} />
        </div>
      )
    /*
      Reasoning is never drawn as a lone row: `segmentsOf` gathers every
      consecutive block into one group, which BlockList renders.
    */
    case 'reasoning':
      return null
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

/** Rows of one turn, drawn as author blocks. */
function BlockList({
  nodes,
  statusOf,
  startOpen = false,
  onAnswer,
}: {
  nodes: readonly ChatNode[]
  statusOf: (member: string) => MemberState['status'] | undefined
  /** Open every member panel on sight, for a view that is only one member. */
  startOpen?: boolean
  onAnswer: (requestId: string, answers: Record<string, string>) => void
}) {
  return (
    <>
      {blocksOf(nodes).map((block, index) => (
        <BlockView
          key={`${String(index)}-${block.member ?? 'lead'}-${block.nodes[0]?.id ?? ''}`}
          block={block}
          status={block.member === undefined ? undefined : statusOf(block.member)}
          startOpen={startOpen}
          onAnswer={onAnswer}
        />
      ))}
    </>
  )
}

/**
 * One turn: the prompt, its work folded behind a single line, then the answer.
 *
 * The fold is the point. A finished turn's forty rows of tool calls are how the
 * answer was reached, not the answer, and leaving them expanded meant scrolling
 * past all of them to find the two paragraphs that were actually asked for. A
 * live turn is never folded — while it is running, the work IS what there is to
 * read — and a turn that produced no answer stays open by default, because
 * folding it would leave a line of summary and nothing else.
 * @param props - The turn, whether it is the one still running, and callbacks.
 * @returns The turn's rows.
 */
function TurnView({
  turn,
  live,
  statusOf,
  onAnswer,
}: {
  turn: Turn
  live: boolean
  statusOf: (member: string) => MemberState['status'] | undefined
  onAnswer: (requestId: string, answers: Record<string, string>) => void
}) {
  // `null` means "nobody has decided yet", which is what lets a turn fold
  // itself the moment it finishes without an effect racing the render: while it
  // runs the default is open, and the same default reads as closed once there
  // is an answer to fold behind.
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = live || (open ?? turn.result.length === 0)
  const steps = turn.work.filter(node => node.kind === 'tool').length
  // Named on the summary line because it changes what is behind it: a team
  // turn folds four agents' work away, not one agent's.
  const agents = new Set(
    turn.work.flatMap(node => ('member' in node && node.member !== undefined ? [node.member] : [])),
  ).size

  const work = <BlockList nodes={turn.work} statusOf={statusOf} onAnswer={onAnswer} />

  return (
    <>
      <BlockList nodes={turn.prompt} statusOf={statusOf} onAnswer={onAnswer} />
      {turn.work.length > 0 && (live
        ? work
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
                <span className={css.trailSteps}>
                  {steps === 1 ? '1 step' : `${String(steps)} steps`}
                </span>
              )}
              {agents > 0 && (
                <span className={css.trailSteps}>
                  {agents === 1 ? '1 agent' : `${String(agents)} agents`}
                </span>
              )}
            </button>
            {expanded && <div className={css.trailBody}>{work}</div>}
          </div>
        ))}
      {turn.result.length > 0 && (
        <section className={css.answerBlock} aria-label={live ? 'Response in progress'
          : turn.result.some(node => node.kind === 'text' && node.incomplete) ? 'Partial response' : 'Final response'}>
          <div className={css.answerLabel}>
            {turn.result.some(node => node.kind === 'text')
              ? live ? 'Response in progress'
                : turn.result.some(node => node.kind === 'text' && node.incomplete) ? 'Partial answer' : 'Final answer'
              : 'Run status'}
          </div>
          <BlockList nodes={turn.result} statusOf={statusOf} onAnswer={onAnswer} />
        </section>
      )}
    </>
  )
}

export interface ChatViewProps {
  chat: ChatController
  /** Model, effort, and loop-mode controls rendered on the composer bar. */
  settings: SettingsController
  /** Conversation title shown in the column header. */
  title: string
  /**
   * The open project's name, shown before the title.
   *
   * Its `workspace` path is the crumb's tooltip: two projects can be named for
   * the same folder basename, and the path is what tells them apart.
   */
  project: string
  /** Effective provider/model for the next run. */
  modelLabel: string
  /** Directory the agent's tools are confined to. */
  workspace: string
  /** Open the project dialog from the project crumb. */
  onOpenProjects: () => void
  onOpenSettings: () => void
}

/**
 * Render the transcript and the composer.
 * @param props - Chat controller plus the header's context.
 * @returns The centre column.
 */
export function ChatView({
  chat, settings, title, project, modelLabel, workspace, onOpenProjects, onOpenSettings,
}: ChatViewProps) {
  const [draft, setDraft] = useState('')
  const [focusRequest, setFocusedMember] = useState<string | null>(null)
  const attachments = useAttachments()
  const picker = useRef<HTMLInputElement | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)
  /**
   * The `/` trigger under the caret, when there is one.
   *
   * Tracked in state rather than derived from `draft`, because it depends on
   * the CARET as well as the text: the same draft has a live trigger when the
   * caret sits inside `/rev` and none when it has moved to the end of the line.
   */
  const [trigger, setTrigger] = useState<SkillTrigger | undefined>(undefined)
  // Keyed on whether a trigger exists at all, not on whether the menu has
  // matches: the fetch is what PRODUCES the matches.
  const catalogue = useSkillCatalogue(settings.groupId, trigger !== undefined)
  const matches = useMemo(
    () => trigger === undefined ? [] : matchSkills(catalogue, trigger.query),
    [catalogue, trigger],
  )
  const [active, setActive] = useActiveIndex(matches.length)
  /** The textarea's scroll offset, so the drawn layer can follow it. */
  const [scrolled, setScrolled] = useState(0)
  /**
   * Skills attached to the message being composed.
   *
   * Picking from the menu takes the `/word` OUT of the draft and puts it here,
   * so the message stays a sentence and the attachment is something you can see
   * and remove. Typing `/id` by hand still works and is read from the text;
   * both reach the backend, which reconciles them against the catalogue.
   */
  const [attached, setAttached] = useState<readonly SkillMention[]>([])
  /** Whether the draft has a mention worth colouring — see `.painting`. */
  const painting = useMemo(() => mentionRanges(draft, catalogue).length > 0, [draft, catalogue])
  const menuOpen = trigger !== undefined && matches.length > 0
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
  /** Attachments whose upload finished, in the order the rail shows them. */
  const ready = attachments.items.flatMap(
    item => item.upload.status === 'ready' ? [item.upload.record] : [],
  )
  // Nothing to send, or something still on its way up. Send stays disabled
  // through an upload rather than silently dropping the file it is waiting on.
  const sendable = (draft.trim() !== '' || ready.length > 0) && !attachments.uploading

  /** Track the trigger from whatever just moved the caret or the text. */
  const retrack = (element: HTMLTextAreaElement) => {
    setTrigger(skillTriggerAt(element.value, element.selectionStart))
  }

  const pick = (skill: SkillMention) => {
    if (trigger === undefined) return
    // The trigger text is removed rather than completed: the skill is now a
    // chip, and leaving `/id` behind would attach it twice over.
    const next = detachTrigger(draft, trigger)
    setDraft(next.draft)
    setTrigger(undefined)
    setAttached(current => current.some(entry => entry.id === skill.id)
      ? current
      : [...current, skill])
    requestAnimationFrame(() => {
      const element = input.current
      if (element === null) return
      element.focus()
      element.setSelectionRange(next.caret, next.caret)
    })
  }

  const detach = (id: string) => {
    setAttached(current => current.filter(skill => skill.id !== id))
    input.current?.focus()
  }

  const submit = () => {
    if (!sendable) return
    const text = draft.trim()
    const skillIds = attached.map(skill => skill.id)
    setDraft('')
    setAttached([])
    attachments.clear()
    // The pickers may be showing a remembered model that the conversation row
    // does not carry yet — a new chat has no row until something writes one.
    // Persisting first is what makes the first prompt run on the model on
    // screen instead of failing with "pick a model before sending a message".
    void (async () => {
      await settings.persistPending()
      // Steering carries text and nothing else — it injects a string into the
      // running agent's history — so a message with files starts its own turn
      // instead of losing them.
      await (chat.running && ready.length === 0
        ? chat.steer(text, skillIds)
        : chat.send(text, ready, skillIds))
    })()
  }

  const statusOf = (member: string) =>
    chat.members.find(entry => entry.name === member)?.status

  // The run's own roster while it has one, the transcript's afterwards — so a
  // team conversation can still be read one agent at a time once it is over.
  const transcript = useMemo(() => withDelegationPrompts(chat.nodes), [chat.nodes])
  const roster = chat.members.length > 0 ? chat.members : rosterOf(transcript)
  // A filter outlives the conversation it was set in, and switching to a chat
  // that never had that member would leave the column filtered to nobody.
  const focusedMember = focusRequest !== null && roster.some(entry => entry.name === focusRequest)
    ? focusRequest
    : null

  // Focusing a member is a filter across the whole conversation, so it drops
  // the prompts the turns are cut on. Those rows are shown flat rather than
  // folded into turns that no longer have a shape.
  const focused = focusedMember === null
    ? undefined
    : transcript.filter(node => 'member' in node && node.member === focusedMember)
  const turns = turnsOf(transcript)

  // At most one prompt is shown at a time: the calls in a batch are parked
  // independently, and answering them one by one is what the user can follow.
  const parked = chat.nodes.find(
    (node): node is Extract<ChatNode, { kind: 'approval' }> =>
      node.kind === 'approval' && node.decision === undefined,
  )

  return (
    <div className={css.column}>
      <header className={css.header}>
        {/*
          Project first, then the conversation. Which project is open decides
          what every tool in a run can read and write, and the header used to
          name only the conversation — with the project reduced to a folder chip
          at the far right, where it read as a setting rather than as the place
          the work is happening.
        */}
        <nav className={css.crumbs} aria-label="Location">
          <button
            type="button"
            className={css.crumbProject}
            title={workspace}
            onClick={onOpenProjects}
          >
            <IconFolderOpen16 />
            <span className={css.crumbText}>{project}</span>
          </button>
          <span className={css.crumbSep} aria-hidden="true">›</span>
          <span className={css.crumbTitle}>{title}</span>
        </nav>
        <div className={css.headerMeta}>
          <button
            type="button"
            className={css.chip}
            onClick={onOpenSettings}
            title="Settings"
          >
            <IconSettingsOutline16 />
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
          {focused !== undefined
            ? (focused.length === 0
                ? (
                  /*
                    A member on the roster that has not reported yet. Without
                    this the column simply went blank, which reads as a broken
                    filter rather than as "nothing from this one so far".
                  */
                  <div className={css.focusEmpty}>
                    Nothing from <b>{focusedMember}</b> yet — it is on the roster but has not
                    reported.
                  </div>
                )
                : (
                  <BlockList
                    nodes={focused}
                    statusOf={statusOf}
                    // Asking for one member IS asking to see its work: a panel
                    // that stayed folded because the member had finished made
                    // every chip on the roster show the same one-line strip.
                    startOpen
                    onAnswer={(requestId, answers) => { void chat.answer(requestId, answers) }}
                  />
                ))
            : turns.map((turn, index) => (
              <TurnView
                key={`turn-${String(index)}-${turn.prompt[0]?.id ?? turn.work[0]?.id ?? ''}`}
                turn={turn}
                live={chat.running && index === turns.length - 1}
                statusOf={statusOf}
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
          onDecide={(callId, decision, scope, ruleKey) => {
            void chat.approve(callId, decision, scope, ruleKey)
          }}
        />
      )}

      <div className={css.composerWrap}>
        <div className={css.composerInner}>
          <TeamRoster
            members={roster}
            focused={focusedMember}
            onFocus={setFocusedMember}
          />
        </div>
        <div className={css.composer}>
          <ComposerAttachments attachments={attachments} />
          {menuOpen && (
            <SkillMenu skills={matches} active={active} onPick={pick} onHover={setActive} />
          )}
          <div className={css.inputRow}>
            <SkillChips skills={attached} onRemove={detach} />
            <div className={clsx(css.inputWrap, painting && css.painting)}>
              <MentionHighlights draft={draft} skills={catalogue} scrollTop={scrolled} />
              <textarea
                ref={input}
                className={css.input}
                value={draft}
                rows={1}
                placeholder={chat.running
                  ? 'Steer the agent — it reads this on its next step…'
                  : 'Ask anything about the workspace…'}
                onChange={(event) => {
                  setDraft(event.target.value)
                  retrack(event.target)
                }}
                // A click or an arrow key can move the caret out of a trigger — or
                // back into one — without changing a character of the text.
                onSelect={(event) => { retrack(event.currentTarget) }}
                onBlur={() => { setTrigger(undefined) }}
                onPaste={(event) => {
                  // A screenshot on the clipboard is the fastest way an image ever
                  // reaches a chat, and it arrives as a file item with no name.
                  const files = [...event.clipboardData.items]
                    .filter(item => item.kind === 'file')
                    .map(item => item.getAsFile())
                    .filter((file): file is File => file !== null)
                  if (files.length === 0) return
                  // Only the files are taken; any text on the clipboard still
                  // pastes into the box, which is what a mixed copy meant.
                  attachments.add(files)
                  if (event.clipboardData.getData('text/plain') === '') event.preventDefault()
                }}
                // A long draft scrolls inside the box; the painted layer has to
                // scroll with it or the coloured text stays on the first line.
                onScroll={(event) => { setScrolled(event.currentTarget.scrollTop) }}
                onKeyDown={(event) => {
                  // Backspace at the very start takes the last chip, the way any
                  // token field behaves — otherwise a chip can only be removed
                  // with the mouse.
                  if (event.key === 'Backspace' && draft === '' && attached.length > 0) {
                    event.preventDefault()
                    setAttached(current => current.slice(0, -1))
                    return
                  }
                  if (menuOpen) {
                    const chosen = matches[active]
                    // Enter and Tab complete rather than send: with a menu open the
                    // user is picking, and sending the half-typed `/rev` would be
                    // the one thing they did not ask for.
                    if ((event.key === 'Enter' || event.key === 'Tab') && chosen !== undefined) {
                      event.preventDefault()
                      pick(chosen)
                      return
                    }
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      const step = event.key === 'ArrowDown' ? 1 : -1
                      setActive((active + step + matches.length) % matches.length)
                      return
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setTrigger(undefined)
                      return
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    submit()
                  }
                }}
              />
            </div>
          </div>
          <div className={css.composerActions}>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                attachments.add([...event.target.files ?? []])
                // Cleared so picking the same file twice in a row still fires
                // a change event.
                event.target.value = ''
              }}
            />
            <button
              type="button"
              className={css.attach}
              aria-label="Attach files"
              title="Attach images or files"
              disabled={!attachments.canAccept}
              onClick={() => { picker.current?.click() }}
            >
              <IconPaperclipOutline16 />
            </button>
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
            {/* Stop is what an empty composer offers during a run. A failed
                upload left in the rail is not something to send, so it does
                not take the stop control away. */}
            {chat.running && draft.trim() === '' && ready.length === 0 && !attachments.uploading
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
                  disabled={!sendable}
                  aria-label={chat.running && ready.length === 0 ? 'Steer' : 'Send'}
                  title={attachments.uploading ? 'Waiting for the upload to finish' : undefined}
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
