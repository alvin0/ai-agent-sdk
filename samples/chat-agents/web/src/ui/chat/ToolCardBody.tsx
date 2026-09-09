'use client'

/**
 * The typed result cards, rendered from the wire's `ToolCard` union.
 *
 * Shared by two surfaces that show the same shapes for different reasons: a
 * settled tool row shows what a call DID, and a permission prompt shows what a
 * call is ABOUT to do — the same diff, the same command, drawn once.
 */

import type { ToolCard } from '@chat-agents/backend'
import {
  DiffBlock, ReadBlock, SearchBlock, StateDot, TerminalBlock, WebBlock,
} from '../primitives'
import type { DiffHunk, SearchFileGroup } from '../primitives'
import { diffLabels, readLabels, searchLabels, terminalLabels, webLabels } from '../labels'
import css from './ToolRow.module.css'

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

/** A filesystem change with nothing line-level to show: create, delete, move. */
function FsCard({ card }: { card: Extract<ToolCard, { kind: 'fs' }> }) {
  return (
    <div className={css.fsCard} data-action={card.action}>
      <span className={css.fsAction}>{card.action}</span>
      <span className={css.fsPath}>{card.path}</span>
      {card.detail !== undefined && <span className={css.fsDetail}>{card.detail}</span>}
    </div>
  )
}

/**
 * Render one result card.
 * @param props - The card to draw.
 * @returns The card body, or null for a kind this surface does not draw.
 */
export function ToolCardBody({ card }: { card: ToolCard }) {
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
      // A listing carries no line numbers; the same card kind serves both, so
      // the absence of them is what distinguishes paths from matches.
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
            total={card.matches.length}
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
    case 'fs':
      return <FsCard card={card} />
    default:
      return null
  }
}
