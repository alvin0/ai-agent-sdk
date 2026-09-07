'use client'

/**
 * Settings: providers and credentials, the agent's workspace, and appearance.
 *
 * Every credential is entered here and stored by the backend — an API key with
 * an optional endpoint override for the keyed providers, and the OAuth
 * device-code flow for Codex, which has no key to paste.
 */

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { DirectoryListing, ProviderInfoView } from '@chat-agents/backend'
import {
  Button, IconCheckOutline16, IconCopyOutline16, IconDarkOutline16, IconFolderOpen16,
  IconFollowsystemOutline16, IconLightOutline16, IconRightUpOutline16, Input, Modal, writeClipboard,
} from '../primitives'
import { AgentsPane, McpPane, SkillsPane } from './GroupPanels'
import type { SettingsController, RunMode } from './useSettings'
import type { ThemeController, ThemePreference } from './theme'
import css from './SettingsDialog.module.css'

/**
 * Settings are GLOBAL: credentials, agent presets, MCP servers, and skill
 * folders apply to every project. A project is only its folder, so it is
 * created and switched from the project dialog instead.
 */
type Tab = 'providers' | 'agents' | 'mcp' | 'skills' | 'appearance'

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'agents', label: 'Agents' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'appearance', label: 'Appearance' },
]

const MODES: readonly { id: RunMode; label: string; hint: string }[] = [
  {
    id: 'basic',
    label: 'Basic',
    hint: 'One answer per turn. No self-check, and the agent cannot stop to ask you a question.',
  },
  {
    id: 'deep',
    label: 'Deep',
    hint: 'The agent must pass a submit_result self-check, so a run answers, submits, then answers again.',
  },
  {
    id: 'deep-human-in-loop',
    label: 'Deep + ask',
    hint: 'Deep, plus the blocking question card: the agent can stop and ask you before continuing.',
  },
]

const THEMES: readonly { id: ThemePreference; label: string; icon: React.ReactNode }[] = [
  { id: 'system', label: 'System', icon: <IconFollowsystemOutline16 /> },
  { id: 'light', label: 'Light', icon: <IconLightOutline16 /> },
  { id: 'dark', label: 'Dark', icon: <IconDarkOutline16 /> },
]

function CodexPanel({ settings }: { settings: SettingsController }) {
  const { codex } = settings
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => { setCopied(false) }, 1_500)
    return () => { clearTimeout(timer) }
  }, [copied])

  if (codex.status === 'signed-in') {
    return (
      <div className={css.authRow}>
        <span className={css.authOk}><IconCheckOutline16 /></span>
        <span className={css.authText}>
          Signed in{codex.account.email === undefined ? '' : ` as ${codex.account.email}`}
          {codex.account.planType === undefined ? '' : ` · ${codex.account.planType}`}
        </span>
      </div>
    )
  }

  if (codex.status === 'pending') {
    return (
      <div className={css.device}>
        <p className={css.deviceStep}>1. Open the verification page and sign in with your ChatGPT account.</p>
        <a className={css.deviceLink} href={codex.verificationUrl} target="_blank" rel="noreferrer noopener">
          {codex.verificationUrl}
          <IconRightUpOutline16 />
        </a>
        <p className={css.deviceStep}>2. Enter this one-time code (it expires in 15 minutes):</p>
        <div className={css.codeRow}>
          <code className={css.code}>{codex.userCode}</code>
          <Button
            variant="ghost"
            icon={<IconCopyOutline16 />}
            onClick={() => { void writeClipboard(codex.userCode).then(() => { setCopied(true) }) }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className={css.deviceWarning}>
          Only continue if you started this sign-in. If someone sent you this code, stop.
        </p>
        <div className={css.deviceActions}>
          <span className={css.muted}>Waiting for authorization…</span>
          <Button variant="ghost" onClick={() => { void settings.cancelCodexLogin() }}>Cancel</Button>
        </div>
      </div>
    )
  }

  return (
    <div className={css.authRow}>
      <span className={css.authText}>{codex.status === 'error' ? codex.message : 'Not signed in.'}</span>
      <Button variant="primary" onClick={() => { void settings.startCodexLogin() }}>
        Sign in with ChatGPT
      </Button>
    </div>
  )
}

function KeyPanel({ view, settings }: { view: ProviderInfoView; settings: SettingsController }) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(view.baseUrl ?? '')
  const [saved, setSaved] = useState(false)

  useEffect(() => { setBaseUrl(view.baseUrl ?? '') }, [view.baseUrl, view.id])
  useEffect(() => { setApiKey('') }, [view.id])
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => { setSaved(false) }, 1_500)
    return () => { clearTimeout(timer) }
  }, [saved])

  const save = async () => {
    await settings.saveCredential(view.id, {
      ...apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() },
      baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
    })
    setApiKey('')
    setSaved(true)
  }

  return (
    <div className={css.form}>
      <label className={css.field}>
        <span className={css.fieldLabel}>API key</span>
        <Input
          type="password"
          autoComplete="off"
          placeholder={view.hasKey ? `Stored ${view.keyHint ?? ''}`.trim() : 'Paste the API key'}
          value={apiKey}
          onChange={(event) => { setApiKey(event.target.value) }}
        />
        <span className={css.fieldHint}>
          {view.hasKey
            ? view.fromEnv
              ? 'Currently seeded from an environment variable. Saving a key here overrides it.'
              : 'Stored by the backend. Only the last four characters are ever returned.'
            : 'Stored by the backend and never sent back to the browser.'}
        </span>
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>Endpoint</span>
        <Input
          placeholder="Provider default"
          value={baseUrl}
          onChange={(event) => { setBaseUrl(event.target.value) }}
        />
        <span className={css.fieldHint}>
          Point the provider at a gateway or proxy. Leave empty for the default endpoint.
        </span>
      </label>

      <div className={css.formActions}>
        {view.hasKey && !view.fromEnv && (
          <Button
            variant="ghost"
            onClick={() => { void settings.saveCredential(view.id, { apiKey: null }) }}
          >
            Remove key
          </Button>
        )}
        <Button variant="primary" onClick={() => { void save() }}>
          {saved ? 'Saved' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

/**
 * Render the settings dialog.
 * @param props - Open state, close callback, settings controller, theme controller.
 * @returns The dialog, or null while closed.
 */
export function SettingsDialog({
  open,
  onClose,
  settings,
  theme,
}: {
  open: boolean
  onClose: () => void
  settings: SettingsController
  theme: ThemeController
}) {
  const [tab, setTab] = useState<Tab>('providers')
  const [active, setActive] = useState('codex')
  const [custom, setCustom] = useState('')

  const { refresh, loadModels } = settings
  useEffect(() => { if (open) void refresh() }, [open, refresh])
  useEffect(() => { if (open) void loadModels(active) }, [open, active, loadModels])

  const view = settings.providers.find(entry => entry.id === active)
  const list = settings.modelsFor(active)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      closeLabel="Close"
      className={css.dialog}
      contentClassName={css.content}
    >
      <nav className={css.tabs}>
        {TABS.map(entry => (
          <button
            type="button"
            key={entry.id}
            className={clsx(css.tab, tab === entry.id && css.tabActive)}
            onClick={() => { setTab(entry.id) }}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'providers' && (
        <div className={css.pane}>
          <div className={css.modeGroup}>
            <div className={css.modes}>
              <span className={css.groupLabel}>Loop</span>
              {MODES.map(entry => (
                <button
                  type="button"
                  key={entry.id}
                  className={clsx(css.chip, settings.mode === entry.id && css.chipSelected)}
                  onClick={() => { void settings.setMode(entry.id) }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <p className={css.muted}>{MODES.find(entry => entry.id === settings.mode)?.hint}</p>
          </div>

          <div className={css.layout}>
            <ul className={css.providerList}>
              {settings.providers.map(provider => (
                <li key={provider.id}>
                  <button
                    type="button"
                    className={clsx(css.providerItem, provider.id === active && css.providerItemActive)}
                    onClick={() => { setActive(provider.id) }}
                  >
                    <span className={css.providerLabel}>{provider.label}</span>
                    <span className={clsx(css.providerHint, provider.ready && css.providerReady)}>
                      {provider.hint}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className={css.detail}>
              {view?.auth === 'oauth' ? <CodexPanel settings={settings} /> : null}
              {view !== undefined && view.auth === 'api-key' && (
                <KeyPanel view={view} settings={settings} />
              )}

              <div className={css.modelSection}>
                <span className={css.groupLabel}>Models</span>
                <ul className={css.modelList}>
                  {list.map((model) => {
                    const selected = settings.choice?.provider === active && settings.choice.model === model.id
                    return (
                      <li key={model.id}>
                        <button
                          type="button"
                          className={clsx(css.modelItem, selected && css.modelItemSelected)}
                          disabled={view?.ready !== true}
                          onClick={() => {
                            void settings.choose({ provider: active, model: model.id })
                            onClose()
                          }}
                        >
                          <span>{model.id}</span>
                          {model.efforts.length > 0 && (
                            <span className={css.modelEfforts}>{model.efforts.join(' · ')}</span>
                          )}
                          {selected && <IconCheckOutline16 />}
                        </button>
                      </li>
                    )
                  })}
                  {list.length === 0 && <li className={css.muted}>No models to suggest yet.</li>}
                </ul>
                <div className={css.customRow}>
                  <Input
                    placeholder="Or type a model id…"
                    value={custom}
                    disabled={view?.ready !== true}
                    onChange={(event) => { setCustom(event.target.value) }}
                  />
                  <Button
                    variant="outline"
                    disabled={custom.trim() === '' || view?.ready !== true}
                    onClick={() => {
                      void settings.choose({ provider: active, model: custom.trim() })
                      setCustom('')
                      onClose()
                    }}
                  >
                    Use
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'agents' && <AgentsPane settings={settings} />}
      {tab === 'mcp' && <McpPane settings={settings} />}
      {tab === 'skills' && <SkillsPane settings={settings} />}

      {tab === 'appearance' && (
        <div className={css.pane}>
          <span className={css.groupLabel}>Theme</span>
          <div className={css.themeRow}>
            {THEMES.map(entry => (
              <button
                type="button"
                key={entry.id}
                className={clsx(css.themeCard, theme.preference === entry.id && css.themeCardSelected)}
                onClick={() => { theme.set(entry.id) }}
              >
                {entry.icon}
                {entry.label}
              </button>
            ))}
          </div>
          <p className={css.muted}>
            System follows your operating system while this tab stays open.
          </p>
        </div>
      )}
    </Modal>
  )
}
