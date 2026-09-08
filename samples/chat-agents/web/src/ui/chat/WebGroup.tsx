'use client'

/**
 * A run of web fetches, drawn as the sources it reached.
 *
 * The generic tool fold names tools and counts steps, which is right for shell
 * and filesystem work and wrong here: eight rows of full URLs, five of them
 * carrying a paragraph of red error text about an investor-relations page that
 * 404s, is not a record of research — it is the reason the prose around it
 * cannot be read. A research step's answer to "what did you look at" is a short
 * list of hostnames, so that is what this draws, with the calls themselves one
 * click away.
 *
 * A failed fetch is not hidden, and it is not shouted either. Sources that
 * refuse a robot are ordinary during research; the site stays on the rail,
 * dimmed, and the count says how many did not answer.
 */

import { useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconGlobeOutline14 } from '../primitives'
import { ToolNode } from './ToolNode'
import { webGroupSummary, webVisitsOf } from './toolDisplay'
import type { ChatNode } from './types'
import css from './WebGroup.module.css'

type ToolChatNode = Extract<ChatNode, { kind: 'tool' }>

/**
 * A site's own icon, with a glyph behind it.
 *
 * Fetched from the site rather than from an icon service: the page was just
 * requested from that host anyway, and routing every source through a third
 * party would tell it what the agent reads.
 */
function Favicon({ host }: { host: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) return <IconGlobeOutline14 className={css.favicon} />
  return (
    <img
      className={css.favicon}
      src={`https://${host}/favicon.ico`}
      alt=""
      loading="lazy"
      onError={() => { setBroken(true) }}
    />
  )
}

export interface WebGroupProps {
  /** The run's web calls, in order; all settled. */
  nodes: readonly ToolChatNode[]
}

/**
 * Render one folded run of web fetches.
 * @param props - The calls in the run.
 * @returns The source rail, and the calls when it is open.
 */
export function WebGroup({ nodes }: WebGroupProps) {
  const [open, setOpen] = useState(false)
  const visits = webVisitsOf(nodes)
  const failed = visits.filter(visit => visit.failed).length

  return (
    <div className={css.group}>
      <button
        type="button"
        className={css.toggle}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        {visits[0] === undefined
          ? <IconGlobeOutline14 className={css.favicon} />
          : <Favicon host={visits[0].host} />}
        <span className={css.label}>{webGroupSummary(nodes.length, visits.length)}</span>
        {failed > 0 && (
          <span className={css.quiet}>· {String(failed)} didn&apos;t answer</span>
        )}
        {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
      </button>

      {/*
        The rail stays visible whether or not the fold is open: it IS the
        summary, and putting it behind the same chevron as the raw calls would
        leave the collapsed row saying only how many pages there were.
      */}
      {visits.length > 0 && (
        <div className={css.rail}>
          {visits.map(visit => (
            <span
              key={visit.host}
              className={clsx(css.chip, visit.failed && css.chipFailed)}
              title={visit.failed ? `${visit.url} — no answer` : visit.url}
            >
              <Favicon host={visit.host} />
              <span className={css.chipText}>{visit.host}</span>
              {visit.count > 1 && <span className={css.chipCount}>{visit.count}</span>}
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className={css.rows}>
          {nodes.map((node, index) => (
            <ToolNode key={`${node.id}-${String(index)}`} node={node} />
          ))}
        </div>
      )}
    </div>
  )
}
