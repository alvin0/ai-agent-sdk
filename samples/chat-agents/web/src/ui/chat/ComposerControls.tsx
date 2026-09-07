'use client'

/**
 * The controls that live on the composer bar: which model runs the next turn,
 * how hard it should think, and which loop policy the conversation uses.
 *
 * They edit the conversation row directly, so what the bar shows is what the
 * next run will actually use.
 */

import { useMemo, useState } from 'react'
import { IconChevronDownOutline14, IconSparkle16, IconThinkOutline14, Menu } from '../primitives'
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
  icon,
  open,
  onClick,
}: {
  label: string
  hint?: string
  icon?: React.ReactNode
  open: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={css.chip} data-open={open || undefined} onClick={onClick}>
      {icon}
      <span className={css.chipLabel}>{label}</span>
      {hint !== undefined && <span className={css.chipHint}>{hint}</span>}
      <IconChevronDownOutline14 />
    </button>
  )
}

/**
 * Render the composer's model, effort, and loop-mode pickers.
 * @param props - The settings controller for the open conversation.
 * @returns The three chips.
 */
export function ComposerControls({ settings }: { settings: SettingsController }) {
  const [openMenu, setOpenMenu] = useState<'model' | 'effort' | 'mode' | null>(null)

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
        entries.push({ id: `${provider.id}::${model.id}`, label: model.id })
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
        items={modelEntries}
        onSelect={(id) => {
          const [provider, model] = id.split('::')
          if (provider !== undefined && model !== undefined) void settings.choose({ provider, model })
          setOpenMenu(null)
        }}
        anchor={(
          <Chip
            label={modelLabel}
            icon={<IconSparkle16 />}
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
        open={openMenu === 'effort'}
        onClose={() => { setOpenMenu(null) }}
        portal
        side="top"
        align="start"
        className={css.menu}
        selectedId={effort}
        items={efforts.map(level => ({
          id: level,
          label: level === selectedModel?.defaultEffort ? `${level} (default)` : level,
        }))}
        onSelect={(id) => {
          void settings.setEffort(id)
          setOpenMenu(null)
        }}
        anchor={(
          <Chip
            label={effort}
            icon={<IconThinkOutline14 />}
            open={openMenu === 'effort'}
            onClick={() => { setOpenMenu(current => (current === 'effort' ? null : 'effort')) }}
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
          { type: 'label', id: 'l_single', text: 'One agent' },
          { id: 'basic', label: 'Basic' },
          { id: 'deep', label: 'Deep' },
          { id: 'deep-human-in-loop', label: 'Deep + ask' },
          { type: 'label', id: 'l_team', text: 'Multiple agents' },
          {
            id: 'team',
            label: 'Team',
            // A roster with nobody in it would silently behave like one agent.
            disabled: settings.agents.filter(agent => agent.inTeam === 1).length === 0,
          },
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
