'use client'

/**
 * Token spend, per provider / model / effort.
 *
 * The backend records one row per model call, so a deep or team run is counted
 * call by call rather than as a single lump — which is what makes the effort
 * column meaningful. Cached input is shown apart from fresh input because the
 * two are not billed the same.
 */

import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import type { UsageSummary } from '@chat-agents/backend'
import { Button } from '../primitives'
import css from './UsagePane.module.css'

const EMPTY: UsageSummary = {
  rows: [],
  totals: {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, calls: 0,
  },
  since: null,
}

/**
 * Group digits so a seven-figure token count is readable at a glance.
 * @param value - A token count.
 * @returns The formatted number.
 */
function tokens(value: number): string {
  return value.toLocaleString()
}

/**
 * Render the usage tab.
 * @param props - The project to scope to; empty counts every project.
 * @returns The pane.
 */
export function UsagePane({ groupId }: { groupId: string }) {
  const [summary, setSummary] = useState<UsageSummary>(EMPTY)
  const [scoped, setScoped] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(async () => {
    const query = scoped && groupId !== '' ? `?groupId=${encodeURIComponent(groupId)}` : ''
    const response = await fetch(`/api/usage${query}`)
    if (!response.ok) return
    setSummary(await response.json() as UsageSummary)
  }, [groupId, scoped])

  useEffect(() => { void load() }, [load])

  const { totals, rows } = summary

  return (
    <div className={css.pane}>
      <div className={css.head}>
        <div className={css.scope}>
          <button
            type="button"
            className={clsx(css.chip, !scoped && css.chipSelected)}
            onClick={() => { setScoped(false) }}
          >
            All projects
          </button>
          <button
            type="button"
            className={clsx(css.chip, scoped && css.chipSelected)}
            onClick={() => { setScoped(true) }}
          >
            This project
          </button>
        </div>
        {/* Clearing is not undoable, so the button asks once before it does it. */}
        <Button
          variant={confirming ? 'primary' : 'ghost'}
          disabled={rows.length === 0}
          onClick={() => {
            if (!confirming) {
              setConfirming(true)
              return
            }
            setConfirming(false)
            const query = scoped && groupId !== '' ? `?groupId=${encodeURIComponent(groupId)}` : ''
            void fetch(`/api/usage${query}`, { method: 'DELETE' }).then(() => load())
          }}
        >
          {confirming ? 'Delete the history?' : 'Clear'}
        </Button>
      </div>

      <div className={css.totals}>
        <div className={css.card}>
          <span className={css.cardLabel}>Total tokens</span>
          <span className={css.cardValue}>{tokens(totals.totalTokens)}</span>
        </div>
        <div className={css.card}>
          <span className={css.cardLabel}>Input</span>
          <span className={css.cardValue}>{tokens(totals.inputTokens)}</span>
        </div>
        <div className={css.card}>
          <span className={css.cardLabel}>Cached in</span>
          <span className={css.cardValue}>{tokens(totals.cacheReadTokens)}</span>
        </div>
        <div className={css.card}>
          <span className={css.cardLabel}>Output</span>
          <span className={css.cardValue}>{tokens(totals.outputTokens)}</span>
        </div>
        <div className={css.card}>
          <span className={css.cardLabel}>Model calls</span>
          <span className={css.cardValue}>{tokens(totals.calls)}</span>
        </div>
      </div>

      <div className={css.scroller}>
        <table className={css.table}>
          <thead>
            <tr>
              <th className={css.left}>Model</th>
              <th className={css.left}>Effort</th>
              <th>Calls</th>
              <th>Input</th>
              <th>Cached in</th>
              <th>Cache write</th>
              <th>Output</th>
              <th>Reasoning</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={`${row.provider}::${row.model}::${row.effort ?? ''}`}>
                <td className={clsx(css.left)}>
                  <span className={css.model}>
                    <span className={css.modelId}>{row.model}</span>
                    <span className={css.provider}>{row.provider}</span>
                  </span>
                </td>
                <td className={css.left}>
                  <span className={css.effort}>{row.effort ?? 'default'}</span>
                </td>
                <td>{tokens(row.calls)}</td>
                <td>{tokens(row.inputTokens)}</td>
                <td>{tokens(row.cacheReadTokens)}</td>
                <td>{tokens(row.cacheWriteTokens)}</td>
                <td>{tokens(row.outputTokens)}</td>
                <td>{tokens(row.reasoningTokens)}</td>
                <td>{tokens(row.totalTokens)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className={css.empty} colSpan={9}>Nothing recorded yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className={css.muted}>
        {summary.since === null
          ? 'Counted from what each run reports; a provider that reports no usage is not counted.'
          : `Counted since ${new Date(summary.since * 1_000).toLocaleString()}. Cached input is billed
             differently from fresh input, so the two are kept apart.`}
      </p>
    </div>
  )
}
