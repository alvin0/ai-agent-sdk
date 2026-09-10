'use client'

/**
 * Safe GFM renderer for assistant output.
 *
 * This follows the chat-agents sample's mdast pipeline instead of trying to
 * recognize Markdown with regular expressions. In particular, GFM tables,
 * task lists, strikethrough and hard breaks are parsed as syntax rather than
 * leaking their source punctuation into the transcript. Raw HTML is kept as
 * text and link destinations are protocol-checked before becoming anchors.
 */

import { Fragment, createElement } from 'react'
import type { Key, ReactNode } from 'react'
import type * as Md from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { normalizeUri } from 'micromark-util-sanitize-uri'
import clsx from 'clsx'
import css from './Markdown.module.css'

interface RenderContext {
  readonly definitions: ReadonlyMap<string, Md.Definition>
}

/** Render Markdown/GFM as React elements without injecting model-authored HTML. */
export function Markdown({ text }: { text: string }) {
  const root = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
  const definitions = new Map<string, Md.Definition>()
  for (const node of root.children) {
    if (node.type === 'definition' && !definitions.has(node.identifier.toUpperCase())) {
      definitions.set(node.identifier.toUpperCase(), node)
    }
  }
  const context: RenderContext = { definitions }
  const children = root.children
    .map((node, index) => renderBlock(node, index, context))
    .filter((node): node is ReactNode => node !== null)
  return <div className={css.root}>{children}</div>
}

function renderBlock(node: Md.RootContent, key: Key, context: RenderContext): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={key} className={css.paragraph}>{renderPhrasing(node.children, context)}</p>
    case 'heading':
      return createElement(
        `h${String(node.depth)}`,
        { key, className: css.heading, 'data-level': node.depth },
        renderPhrasing(node.children, context),
      )
    case 'blockquote':
      return (
        <blockquote key={key} className={css.quote}>
          {node.children.map((child, index) => renderBlock(child, `${String(key)}-${String(index)}`, context))}
        </blockquote>
      )
    case 'thematicBreak':
      return <hr key={key} />
    case 'break':
      return <Fragment key={key}><br />{ '\n' }</Fragment>
    case 'code':
      return renderCode(node, key)
    case 'list':
      return renderList(node, key, context)
    case 'table':
      return renderTable(node, key, context)
    case 'html':
      return node.value
    case 'definition':
      return null
    default:
      return null
  }
}

function renderPhrasing(nodes: readonly Md.PhrasingContent[], context: RenderContext): ReactNode[] {
  return nodes.map((node, index) => renderInline(node, index, context))
}

function renderInline(node: Md.PhrasingContent, key: Key, context: RenderContext): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value
    case 'emphasis':
      return <em key={key}>{renderPhrasing(node.children, context)}</em>
    case 'strong':
      return <strong key={key}>{renderPhrasing(node.children, context)}</strong>
    case 'delete':
      return <del key={key}>{renderPhrasing(node.children, context)}</del>
    case 'inlineCode':
      return <code key={key} className={css.inlineCode}>{node.value.replace(/\r?\n|\r/gu, ' ')}</code>
    case 'break':
      return <Fragment key={key}><br />{ '\n' }</Fragment>
    case 'link':
      return renderLink(node.url, renderPhrasing(node.children, context), key)
    case 'linkReference': {
      const definition = context.definitions.get(node.identifier.toUpperCase())
      return definition === undefined
        ? `[${renderPhrasing(node.children, context)}]`
        : renderLink(definition.url, renderPhrasing(node.children, context), key)
    }
    case 'image':
      return renderImage(node.url, node.alt ?? '', key)
    case 'imageReference': {
      const definition = context.definitions.get(node.identifier.toUpperCase())
      return definition === undefined ? `![${node.alt ?? ''}]` : renderImage(definition.url, node.alt ?? '', key)
    }
    case 'html':
      return node.value
    case 'footnoteReference':
      return `[${node.label ?? node.identifier}]`
    default:
      return null
  }
}

function renderLink(url: string, children: ReactNode[], key: Key): ReactNode {
  const safe = sanitizeUrl(url)
  if (safe === '') return <Fragment key={key}>{children}</Fragment>
  const external = /^https?:/u.test(safe)
  return (
    <a
      key={key}
      href={safe}
      {...external ? { target: '_blank', rel: 'noopener noreferrer' } : {}}
      className={css.link}
    >
      {children}
    </a>
  )
}

function sanitizeUrl(value: string): string {
  const url = normalizeUri(value)
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' ? url : ''
  } catch {
    return ''
  }
}

function renderImage(url: string, alt: string, key: Key): ReactNode {
  const safe = sanitizeUrl(url)
  if (!/^https?:/u.test(safe)) return alt
  return <img key={key} className={css.image} src={safe} alt={alt} loading="lazy" />
}

function renderCode(node: Md.Code, key: Key): ReactNode {
  const language = node.lang === null ? undefined : node.lang
  return (
    <pre key={key} className={css.code}>
      {language !== undefined && language !== '' && <span className={css.codeLang}>{language}</span>}
      <code className={language === undefined ? undefined : `language-${language}`}>{node.value}</code>
    </pre>
  )
}

function renderList(node: Md.List, key: Key, context: RenderContext): ReactNode {
  const tag = node.ordered === true ? 'ol' : 'ul'
  const className = node.children.some(item => typeof item.checked === 'boolean')
    ? 'contains-task-list'
    : undefined
  return createElement(
    tag,
    {
      key,
      className: clsx(css.list, className),
      ...(node.start !== null && node.start !== 1 ? { start: node.start } : {}),
    },
    node.children.map((item, index) => renderListItem(item, index, context)),
  )
}

function renderListItem(item: Md.ListItem, key: Key, context: RenderContext): ReactNode {
  const children: ReactNode[] = []
  const checkbox = typeof item.checked === 'boolean'
    ? <input type="checkbox" checked={item.checked} disabled />
    : null
  for (const [index, child] of item.children.entries()) {
    const rendered = renderBlock(child, index, context)
    if (rendered === null) continue
    if (index === 0 && checkbox !== null) children.push(checkbox, ' ')
    children.push(rendered)
  }
  return <li key={key}>{children}</li>
}

function renderTable(node: Md.Table, key: Key, context: RenderContext): ReactNode {
  const [head, ...body] = node.children
  const columns = node.align?.length ?? head?.children.length ?? 0
  const wide = columns >= 4
  return (
    <div key={key} className={clsx(css.tableScroll, wide ? css.tableWide : css.tableFill)} tabIndex={wide ? 0 : undefined}>
      <table>
        {head !== undefined && <thead>{renderTableRow(head, 'th', node.align, context)}</thead>}
        {body.length > 0 && <tbody>{body.map((row, index) => renderTableRow(row, 'td', node.align, context, index))}</tbody>}
      </table>
    </div>
  )
}

function renderTableRow(
  row: Md.TableRow,
  cellTag: 'th' | 'td',
  align: readonly Md.AlignType[] | null | undefined,
  context: RenderContext,
  key: Key = 0,
): ReactNode {
  const length = align === null || align === undefined ? row.children.length : align.length
  const cells: ReactNode[] = []
  for (let index = 0; index < length; index++) {
    const cell = row.children[index]
    const alignment = align?.[index]
    cells.push(createElement(
      cellTag,
      { key: index, style: alignment === null || alignment === undefined ? undefined : { textAlign: alignment } },
      ...(cell === undefined ? [] : renderPhrasing(cell.children, context)),
    ))
  }
  return <tr key={key}>{cells}</tr>
}
