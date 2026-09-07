'use client'

/**
 * One tool call rendered as a collapsible row over a typed result card.
 *
 * The row is the harness's shape: leading icon or state dot, tool title, an
 * ellipsized one-line summary, and — once expanded — either a rich card
 * (terminal, read, diff, search, web, todo) or the raw IN/OUT pair.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  CodeBlock, DisclosureRow, StateDot,
  IconChecklistOutline14, IconCodeOutline16, IconEditOutline16, IconFolderClose16,
  IconGlobeOutline14, IconPlayOutline16, IconSearchOutline16, IconTrashOutline16,
} from '../primitives'
import { markdownLabels } from '../labels'
import { ToolCardBody } from './ToolCardBody'
import { opensByDefault, showsLiveOutput } from './toolDisplay'
import type { ChatNode } from './types'
import css from './ToolRow.module.css'

/** Display names, including the mutating tools the user has to permit. */
export const TITLES: Readonly<Record<string, string>> = {
  read_file: 'Read',
  list_directory: 'List',
  search_files: 'Search',
  propose_edit: 'Preview edit',
  write_file: 'Write',
  edit_file: 'Edit',
  delete_path: 'Delete',
  create_directory: 'New folder',
  move_path: 'Move',
  run_command: 'Run',
  write_todos: 'Todos',
  fetch_url: 'Fetch',
  request_user_input: 'Ask',
  close_agent: 'Close agent',
  submit_result: 'Self-check',
}

/**
 * The icon for one tool.
 * @param name - Tool name.
 * @returns The icon element.
 */
export function iconFor(name: string) {
  switch (name) {
    case 'search_files':
    case 'list_directory':
      return <IconSearchOutline16 />
    case 'fetch_url':
      return <IconGlobeOutline14 />
    case 'write_todos':
      return <IconChecklistOutline14 />
    case 'write_file':
    case 'edit_file':
      return <IconEditOutline16 />
    case 'delete_path':
      return <IconTrashOutline16 />
    case 'create_directory':
    case 'move_path':
      return <IconFolderClose16 />
    case 'run_command':
      return <IconPlayOutline16 />
    default:
      return <IconCodeOutline16 />
  }
}

/** One-line collapsed summary derived from the call's arguments. */
function summaryOf(name: string, args: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(args) as Record<string, unknown>
  } catch {
    return args.slice(0, 120)
  }
  // A control tool's arguments are a whole payload; summarise the part a
  // reader recognises rather than the raw JSON.
  if (name === 'request_user_input') {
    const questions = parsed.questions
    const first = Array.isArray(questions) ? questions[0] as { question?: unknown } | undefined : undefined
    if (typeof first?.question === 'string') return first.question
  }
  if (name === 'submit_result' && typeof parsed.summary === 'string') return parsed.summary
  // The command line IS the summary of a shell call; its path arguments are not.
  if (name === 'run_command' && typeof parsed.command === 'string') return parsed.command
  if (name === 'move_path' && typeof parsed.from === 'string' && typeof parsed.to === 'string') {
    return `${parsed.from} → ${parsed.to}`
  }

  // The workspace root reads better than the literal "." the model sends.
  if (typeof parsed.path === 'string' && (parsed.path === '.' || parsed.path === './')) {
    return 'workspace root'
  }

  const first = parsed.path ?? parsed.query ?? parsed.url ?? parsed.items
  if (typeof first === 'string') return first
  if (Array.isArray(first)) return `${first.length} items`
  return Object.keys(parsed).length === 0 ? '' : JSON.stringify(parsed).slice(0, 120)
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/**
 * Output from a command that has not finished.
 *
 * Not `TerminalBlock`: that primitive is a verbatim port and deliberately shows
 * the prompt line alone while `running`, so it cannot show a build in progress.
 * Passing it a settled shape instead would draw a green "Done" dot over a
 * command that is still going.
 */
function LiveOutput({ command, text }: { command: string; text: string }) {
  const tail = useRef<HTMLDivElement | null>(null)
  // Follow the output, which is the entire reason for showing it live.
  useEffect(() => { tail.current?.scrollIntoView({ block: 'end' }) }, [text])
  return (
    <div className={css.live}>
      <div className={css.livePrompt}>
        <span className={css.liveDot} />
        {`$ ${command}`}
      </div>
      <pre className={css.liveBody}>
        {text}
        <div ref={tail} />
      </pre>
    </div>
  )
}

/**
 * Render one tool node.
 * @param props - The transcript node to draw.
 * @returns The collapsible tool row.
 */
export function ToolNode({ node }: { node: Extract<ChatNode, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(opensByDefault(node.name))
  const summary = useMemo(() => summaryOf(node.name, node.args), [node.name, node.args])
  const rowState = node.state === 'running' ? 'running' : node.state === 'error' ? 'error' : 'ok'
  const failure = node.state === 'error' ? node.errorMessage ?? 'failed' : null
  const argsBody = useMemo(() => prettyJson(node.args), [node.args])
  // A command that is printing gets opened for you: being asked to click to
  // find out what a two-minute install is doing defeats streaming it.
  const streaming = showsLiveOutput(node)
  // Once a row has opened itself to stream, it STAYS open. Without this the
  // row springs shut the instant the result lands, because `streaming` goes
  // false while `open` was never set — so the output a user was reading
  // vanishes at the exact moment it became complete.
  useEffect(() => { if (streaming) setOpen(true) }, [streaming])
  const command = useMemo(() => {
    try {
      const parsed = JSON.parse(node.args) as { command?: unknown }
      return typeof parsed.command === 'string' ? parsed.command : node.name
    } catch {
      return node.name
    }
  }, [node.args, node.name])

  return (
    <div className={css.root} data-tool={node.name} data-state={rowState}>
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={node.state === 'error' ? <StateDot state="error" /> : iconFor(node.name)}
        title={TITLES[node.name] ?? node.name}
        open={open || streaming}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={(failure ?? summary) !== '' && (
          <>
            <span className={css.sep} aria-hidden />
            <span className={clsx(css.summary, failure !== null && css.errorSummary)}>
              {failure ?? summary}
            </span>
          </>
        )}
      >
        <div className={css.bodyWrap}>
          {node.card !== undefined
            ? <ToolCardBody card={node.card} />
            : streaming
              ? <LiveOutput command={command} text={node.liveOutput ?? ''} />
              : (
              <>
                <div className={css.bodyScroll}>
                  <CodeBlock
                    code={argsBody}
                    lang="json"
                    copyLabel={markdownLabels.code.copyLabel}
                    copiedLabel={markdownLabels.code.copiedLabel}
                    className={css.codeBody}
                  />
                </div>
                {node.output !== undefined && node.output !== '' && (
                  <div className={css.ioCard}>
                    <div className={css.ioSection}>
                      <span className={css.ioLabel}>Output</span>
                      <span className={css.ioText} data-error={node.state === 'error' || undefined}>
                        {node.output}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
        </div>
      </DisclosureRow>
    </div>
  )
}
