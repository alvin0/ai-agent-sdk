'use client'

/**
 * One tool call rendered as a collapsible row over a typed result card.
 *
 * The row is the harness's shape: leading icon or state dot, tool title, an
 * ellipsized one-line summary, and — once expanded — either a rich card
 * (terminal, read, diff, search, web, todo) or the raw IN/OUT pair.
 */

import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { ToolCard } from '@chat-agents/backend'
import {
  CodeBlock, DiffBlock, DisclosureRow, ReadBlock, SearchBlock, StateDot, TerminalBlock, WebBlock,
  IconChecklistOutline14, IconCodeOutline16, IconGlobeOutline14, IconSearchOutline16,
} from '../primitives'
import type { DiffHunk, SearchFileGroup } from '../primitives'
import { diffLabels, markdownLabels, readLabels, searchLabels, terminalLabels, webLabels } from '../labels'
import type { ChatNode } from './types'
import css from './ToolRow.module.css'

const TITLES: Readonly<Record<string, string>> = {
  read_file: 'Read',
  list_directory: 'List',
  search_files: 'Search',
  propose_edit: 'Edit',
  write_todos: 'Todos',
  fetch_url: 'Fetch',
  request_user_input: 'Ask',
  submit_result: 'Self-check',
}

function iconFor(name: string) {
  switch (name) {
    case 'search_files':
    case 'list_directory':
      return <IconSearchOutline16 />
    case 'fetch_url':
      return <IconGlobeOutline14 />
    case 'write_todos':
      return <IconChecklistOutline14 />
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

/** Rebuild the two sides of a diff card so `DiffBlock` can render it. */
function diffHunk(card: Extract<ToolCard, { kind: 'diff' }>): DiffHunk {
  const oldText = card.lines.filter(line => line.kind !== 'add').map(line => line.text).join('\n')
  const newText = card.lines.filter(line => line.kind !== 'del').map(line => line.text).join('\n')
  return { path: card.path, oldText: oldText === '' ? null : oldText, newText }
}

function searchGroups(card: Extract<ToolCard, { kind: 'search' }>): SearchFileGroup[] {
  const groups = new Map<string, SearchFileGroup>()
  for (const match of card.matches) {
    const existing = groups.get(match.path) ?? { path: match.path, matches: [] }
    existing.matches.push({ lineNumber: match.line, line: match.text })
    groups.set(match.path, existing)
  }
  return [...groups.values()]
}

function TodoCard({ card }: { card: Extract<ToolCard, { kind: 'todo' }> }) {
  return (
    <ul className={css.todoList}>
      {card.items.map((item, index) => (
        <li className={css.todoItem} key={`${item.text}-${String(index)}`} data-status={item.status}>
          <StateDot state={item.status === 'done' ? 'done' : item.status === 'active' ? 'ongoing' : 'warning'} />
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  )
}

function CardBody({ card }: { card: ToolCard }) {
  switch (card.kind) {
    case 'terminal':
      return (
        <TerminalBlock
          command={card.command}
          output={card.output}
          exitCode={card.exitCode}
          maxLines={Infinity}
          labels={terminalLabels}
          className={css.terminalBody}
        />
      )
    case 'read':
      return (
        <ReadBlock
          label={card.path}
          lines={card.lines.map((text, index) => ({ number: card.firstLine + index, text }))}
          totalLines={card.firstLine + card.lines.length - 1 + (card.truncated ? 1 : 0)}
          labels={readLabels}
          className={css.readBody}
        />
      )
    case 'diff':
      return <DiffBlock diffs={[diffHunk(card)]} labels={diffLabels} className={css.diffBody} />
    case 'search': {
      const groups = searchGroups(card)
      const total = card.matches.length
      return groups.every(group => group.matches.every(match => match.lineNumber === 0))
        ? (
          <SearchBlock
            kind="paths"
            paths={groups.map(group => group.path)}
            total={groups.length}
            truncated={false}
            labels={searchLabels}
            className={css.searchBody}
          />
        )
        : (
          <SearchBlock
            kind="matches"
            files={groups}
            total={total}
            truncated={false}
            labels={searchLabels}
            className={css.searchBody}
          />
        )
    }
    case 'web':
      return (
        <WebBlock
          kind="search"
          sources={[{ url: card.url, title: card.title, snippet: card.snippet }]}
          truncated={false}
          labels={webLabels}
          className={css.webBody}
        />
      )
    case 'todo':
      return <TodoCard card={card} />
    default:
      return null
  }
}

/**
 * Render one tool node.
 * @param props - The transcript node to draw.
 * @returns The collapsible tool row.
 */
export function ToolNode({ node }: { node: Extract<ChatNode, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const summary = useMemo(() => summaryOf(node.name, node.args), [node.name, node.args])
  const rowState = node.state === 'running' ? 'running' : node.state === 'error' ? 'error' : 'ok'
  const failure = node.state === 'error' ? node.errorMessage ?? 'failed' : null
  const argsBody = useMemo(() => prettyJson(node.args), [node.args])

  return (
    <div className={css.root} data-tool={node.name} data-state={rowState}>
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={node.state === 'error' ? <StateDot state="error" /> : iconFor(node.name)}
        title={TITLES[node.name] ?? node.name}
        open={open}
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
            ? <CardBody card={node.card} />
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
