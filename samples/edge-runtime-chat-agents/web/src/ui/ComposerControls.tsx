'use client'

/**
 * The controls that live on the composer bar: which model runs the next turn,
 * how hard it should think, and whether one agent or a team answers.
 *
 * Model and effort share ONE chip, as in the chat-agents sample. Effort only
 * means anything relative to a model, so it is a submenu of the model list
 * rather than a second control competing for bar width.
 */

import { useState } from 'react'
import { IconCheckOutline16, IconChevronDownOutline14, Menu } from './primitives'
import type { MenuEntry } from './primitives'
import type { RunMode } from '../server/wire'
import css from './ComposerControls.module.css'

/** Prefix marking an effort row, so it cannot be read as a model id. */
const EFFORT = 'effort#'
/** The row that clears the effort choice. */
const NO_EFFORT = `${EFFORT}`

const MODE_LABELS: Readonly<Record<RunMode, string>> = {
  single: 'Single',
  team: 'Team',
  'team-auto': 'Team · auto',
}

function Chip({
  label,
  hint,
  open,
  onClick,
}: {
  label: string
  hint?: string
  open: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={css.chip} data-open={open || undefined} onClick={onClick}>
      <span className={css.chipLabel}>{label}</span>
      {hint !== undefined && <span className={css.chipHint}>{hint}</span>}
      <IconChevronDownOutline14 />
    </button>
  )
}

export interface ComposerControlsProps {
  /** Ids the browser's catalog holds, in the order it holds them. */
  models: readonly string[]
  efforts: readonly string[]
  /** The model in play, whether chosen here or inherited from the deployment. */
  model: string
  effort: string | undefined
  mode: RunMode
  onModel: (value: string) => void
  onEffort: (value: string | undefined) => void
  onMode: (value: RunMode) => void
  /** Opens the roster editor; only offered in team mode. */
  onEditTeam: () => void
}

/**
 * Render the composer's model, effort, and mode chips.
 * @param props - The options in play and the setters behind them.
 * @returns The chip row.
 */
export function ComposerControls({
  models, efforts, model, effort, mode, onModel, onEffort, onMode, onEditTeam,
}: ComposerControlsProps) {
  const [openMenu, setOpenMenu] = useState<'model' | 'mode' | null>(null)

  // The list is whatever the browser's catalog holds. Adding to it belongs in
  // Settings, not here: a model needs its capacities alongside its id, and a
  // field on the composer bar can only ask for one of the three.
  const modelEntries: MenuEntry[] = models.map(id => ({ id, label: id, searchText: id }))

  return (
    <div className={css.row}>
      <Menu
        open={openMenu === 'model'}
        onClose={() => { setOpenMenu(null) }}
        portal
        side="top"
        align="start"
        className={css.menu}
        selectedId={model}
        search="Search models…"
        items={modelEntries}
        footer={[
          {
            id: 'effort',
            label: (
              <span className={css.menuRow}>
                Effort
                <span className={css.menuValue}>{effort ?? 'default'}</span>
              </span>
            ),
            submenu: [
              {
                id: NO_EFFORT,
                label: (
                  <span className={css.menuRow}>
                    model default
                    <span className={css.menuTail}>
                      <span className={css.menuValue}>provider default</span>
                      {effort === undefined && <IconCheckOutline16 />}
                    </span>
                  </span>
                ),
              },
              ...efforts.map(level => ({
                id: `${EFFORT}${level}`,
                label: (
                  <span className={css.menuRow}>
                    {level}
                    {/* The submenu draws no selection marker of its own. */}
                    <span className={css.menuTail}>
                      {level === effort && <IconCheckOutline16 />}
                    </span>
                  </span>
                ),
              })),
            ],
          },
        ]}
        onSelect={(id) => {
          if (id === NO_EFFORT) { onEffort(undefined); setOpenMenu(null); return }
          if (id.startsWith(EFFORT)) { onEffort(id.slice(EFFORT.length)); setOpenMenu(null); return }
          onModel(id)
          setOpenMenu(null)
        }}
        anchor={(
          <Chip
            label={model}
            {...(effort === undefined ? {} : { hint: effort })}
            open={openMenu === 'model'}
            onClick={() => { setOpenMenu(current => (current === 'model' ? null : 'model')) }}
          />
        )}
      />

      <Menu
        open={openMenu === 'mode'}
        onClose={() => { setOpenMenu(null) }}
        portal
        side="top"
        align="start"
        className={css.menu}
        selectedId={mode}
        items={[
          { id: 'single', label: 'Single' },
          { id: 'team', label: 'Team' },
          { id: 'team-auto', label: 'Team · auto' },
          { type: 'separator', id: 'sep' },
          { id: 'edit', label: 'Edit roster…', disabled: mode !== 'team' },
        ]}
        onSelect={(id) => {
          setOpenMenu(null)
          if (id === 'edit') { onEditTeam(); return }
          onMode(id as RunMode)
        }}
        anchor={(
          <Chip
            label={MODE_LABELS[mode]}
            open={openMenu === 'mode'}
            onClick={() => { setOpenMenu(current => (current === 'mode' ? null : 'mode')) }}
          />
        )}
      />
    </div>
  )
}
