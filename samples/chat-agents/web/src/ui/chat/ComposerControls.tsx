'use client'

/**
 * The controls that live on the composer bar: which model runs the next turn,
 * how hard it should think, and which loop policy the conversation uses.
 *
 * Model and effort share ONE chip. Effort only means anything relative to a
 * model — the ladder a route offers differs per model — so it is a submenu of
 * the model list rather than a second control competing for bar width.
 *
 * They edit the conversation row directly, so what the bar shows is what the
 * next run will actually use.
 */

/** Prefix marking an effort row, so it cannot be read as a provider::model id. */
const EFFORT = 'effort#'

import { useMemo, useState } from 'react'
import {
  IconCheckOutline16, IconChevronDownOutline14, Menu,
} from '../primitives'
import type { MenuEntry } from '../primitives'
import type { SettingsController, RunMode } from '../settings/useSettings'
import css from './ComposerControls.module.css'

const MODE_LABELS: Readonly<Record<RunMode, string>> = {
  basic: 'Basic',
  deep: 'Deep',
  'deep-human-in-loop': 'Deep + ask',
  team: 'Team',
  'team-dynamic': 'Team · auto',
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

/**
 * Render the composer's model, effort, and loop-mode pickers.
 * @param props - The settings controller for the open conversation.
 * @returns The model and mode chips.
 */
export function ComposerControls({ settings }: { settings: SettingsController }) {
  const [openMenu, setOpenMenu] = useState<'model' | 'mode' | null>(null)

  // Only providers that can actually run: a model with no credential behind it
  // is not a choice, it is a dead end. The provider heading is dropped when a
  // single provider is ready, so the list is just models.
  const modelEntries = useMemo((): MenuEntry[] => {
    const ready = settings.providers.filter(provider => provider.ready)
    if (ready.length === 0) {
      return [{ id: '__none', label: 'No provider configured — open Settings', disabled: true }]
    }
    const entries: MenuEntry[] = []
    for (const provider of ready) {
      const models = settings.modelsFor(provider.id)
      if (models.length === 0) continue
      if (ready.length > 1) entries.push({ type: 'label', id: `l_${provider.id}`, text: provider.label })
      for (const model of models) {
        entries.push({
          id: `${provider.id}::${model.id}`,
          label: model.id,
          // Typing a provider name narrows to its models, which the row itself
          // does not spell out once the heading has scrolled away.
          searchText: `${provider.label} ${provider.id} ${model.id}`,
        })
      }
    }
    return entries.length === 0
      ? [{ id: '__empty', label: 'No models available', disabled: true }]
      : entries
  }, [settings.providers, settings.modelsFor])

  const modelLabel = settings.choice === undefined ? 'Auto model' : settings.choice.model
  // Effort levels belong to the exact model route, not to the provider: a
  // Codex route can offer xhigh/max/ultra while another stops at high.
  const efforts = settings.effortsFor(settings.choice?.provider ?? '', settings.choice?.model)
  const selectedModel = settings.choice === undefined
    ? undefined
    : settings.modelsFor(settings.choice.provider).find(entry => entry.id === settings.choice?.model)
  const effort = settings.effort ?? selectedModel?.defaultEffort ?? 'medium'

  /**
   * Whether the static-team row is worth offering.
   *
   * An empty roster makes Team behave like one agent, so it is hidden — unless
   * the conversation is already ON Team, because a selected mode with no row
   * would leave the chip naming a choice the list does not contain.
   */
  const hasRoster = settings.agents.some(agent => agent.inTeam === 1)
    || settings.mode === 'team'

  return (
    <div className={css.row}>
      <Menu
        open={openMenu === 'model'}
        onClose={() => { setOpenMenu(null) }}
        portal
        side="top"
        align="start"
        className={css.menu}
        selectedId={settings.choice === undefined
          ? undefined
          : `${settings.choice.provider}::${settings.choice.model}`}
        search="Search models…"
        items={modelEntries}
        footer={[
          {
            id: 'effort',
            label: (
              <span className={css.menuRow}>
                Effort
                <span className={css.menuValue}>{effort}</span>
              </span>
            ),
            submenu: efforts.map(level => ({
              id: `${EFFORT}${level}`,
              label: (
                <span className={css.menuRow}>
                  {level}
                  <span className={css.menuTail}>
                    {level === selectedModel?.defaultEffort && (
                      <span className={css.menuValue}>default</span>
                    )}
                    {/* The submenu draws no selection marker of its own. */}
                    {level === effort && <IconCheckOutline16 />}
                  </span>
                </span>
              ),
            })),
          },
        ]}
        onSelect={(id) => {
          if (id.startsWith(EFFORT)) {
            void settings.setEffort(id.slice(EFFORT.length))
            setOpenMenu(null)
            return
          }
          const [provider, model] = id.split('::')
          if (provider !== undefined && model !== undefined) void settings.choose({ provider, model })
          setOpenMenu(null)
        }}
        anchor={(
          <Chip
            label={modelLabel}
            hint={effort}
            open={openMenu === 'model'}
            onClick={() => {
              setOpenMenu(current => (current === 'model' ? null : 'model'))
              // Discover the catalogue for the ready providers only.
              for (const provider of settings.providers) {
                if (provider.ready) void settings.loadModels(provider.id)
              }
            }}
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
        selectedId={settings.mode}
        items={[
          { type: 'label', id: 'l_agent', text: 'Agent' },
          { id: 'basic', label: 'Basic' },
          { id: 'deep', label: 'Deep' },
          { id: 'deep-human-in-loop', label: 'Deep + ask' },
          { type: 'separator', id: 'sep_team' },
          // A roster with nobody in it would behave like one agent, so the row
          // is not offered at all until a preset has been added to the team.
          ...hasRoster
            ? [{ id: 'team', label: 'Team' } as const]
            : [],
          { id: 'team-dynamic', label: 'Team · auto' },
        ]}
        onSelect={(id) => {
          void settings.setMode(id as RunMode)
          setOpenMenu(null)
        }}
        anchor={(
          <Chip
            label={MODE_LABELS[settings.mode]}
            open={openMenu === 'mode'}
            onClick={() => { setOpenMenu(current => (current === 'mode' ? null : 'mode')) }}
          />
        )}
      />
    </div>
  )
}
