'use client'

/**
 * The group-scoped settings panes: agent presets, MCP servers, and skill roots.
 *
 * Everything here belongs to the OPEN GROUP, so switching group switches which
 * agents, remote tools, and skills a run can reach.
 */

import { useState } from 'react'
import clsx from 'clsx'
import type { AgentRow, McpServerRow, SkillRow } from '@chat-agents/backend'
import { Button, IconCheckOutline16, IconTrashOutline16, Input, StateDot } from '../primitives'
import type { SettingsController } from './useSettings'
import css from './GroupPanels.module.css'

const MODES = ['basic', 'deep', 'deep-human-in-loop'] as const

function AgentEditor({
  agent,
  settings,
  onDone,
}: {
  agent: AgentRow | undefined
  settings: SettingsController
  onDone: () => void
}) {
  const [name, setName] = useState(agent?.name ?? '')
  const [description, setDescription] = useState(agent?.description ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '')
  const [mode, setMode] = useState(agent?.mode ?? 'basic')
  const [effort, setEffort] = useState(agent?.reasoningEffort ?? '')
  const [model, setModel] = useState(
    agent?.provider != null && agent.model != null ? `${agent.provider}::${agent.model}` : '',
  )

  const [modelProvider, modelId] = model === '' ? ['', undefined] : model.split('::') as [string, string]

  const save = async () => {
    const [provider, chosenModel] = model === '' ? [null, null] : model.split('::')
    const payload = {
      name,
      description: description === '' ? null : description,
      systemPrompt: systemPrompt === '' ? null : systemPrompt,
      provider: provider ?? null,
      model: chosenModel ?? null,
      mode,
      reasoningEffort: effort === '' ? null : effort,
    }
    if (agent === undefined) await settings.createAgent(payload)
    else await settings.updateAgent(agent.id, payload)
    onDone()
  }

  return (
    <div className={css.form}>
      <label className={css.field}>
        <span className={css.fieldLabel}>Name</span>
        <Input value={name} placeholder="Reviewer" onChange={(e) => { setName(e.target.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>Description</span>
        <Input
          value={description}
          placeholder="What this agent is for"
          onChange={(e) => { setDescription(e.target.value) }}
        />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>System prompt</span>
        <textarea
          className={css.textarea}
          rows={6}
          value={systemPrompt}
          placeholder="Replaces the default system prompt for this agent."
          onChange={(e) => { setSystemPrompt(e.target.value) }}
        />
      </label>
      <div className={css.grid}>
        <label className={css.field}>
          <span className={css.fieldLabel}>Model</span>
          <select className={css.select} value={model} onChange={(e) => { setModel(e.target.value) }}>
            <option value="">Follow the conversation</option>
            {settings.providers.flatMap(provider =>
              settings.modelsFor(provider.id).map(option => (
                <option key={`${provider.id}::${option.id}`} value={`${provider.id}::${option.id}`}>
                  {provider.label} · {option.id}
                </option>
              )))}
          </select>
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>Loop</span>
          <select className={css.select} value={mode} onChange={(e) => { setMode(e.target.value) }}>
            {MODES.map(entry => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>Effort</span>
          <select className={css.select} value={effort} onChange={(e) => { setEffort(e.target.value) }}>
            <option value="">Follow the conversation</option>
            {/* Efforts follow the preset's pinned model when it has one. */}
            {settings.effortsFor(modelProvider, modelId)
              .map(entry => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </label>
      </div>
      <div className={css.formActions}>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button variant="primary" disabled={name.trim() === ''} onClick={() => { void save() }}>
          {agent === undefined ? 'Create agent' : 'Save agent'}
        </Button>
      </div>
    </div>
  )
}

/**
 * Agent presets: name, system prompt, default model, loop policy, effort.
 * @param props - The settings controller.
 * @returns The agents pane.
 */
export function AgentsPane({ settings }: { settings: SettingsController }) {
  const [editing, setEditing] = useState<AgentRow | 'new' | undefined>(undefined)

  if (editing !== undefined) {
    return (
      <AgentEditor
        agent={editing === 'new' ? undefined : editing}
        settings={settings}
        onDone={() => { setEditing(undefined) }}
      />
    )
  }

  return (
    <div className={css.pane}>
      <div className={css.paneHead}>
        <p className={css.muted}>
          An agent preset replaces the system prompt and can pin its own model, loop policy,
          and effort. The conversation runs the preset you select here — and in <strong>Team
          </strong> mode that preset leads, delegating to every preset marked <strong>In team
          </strong>. <strong>Team · auto</strong> ignores the roster and lets the lead spawn
          its own workers.
        </p>
        <Button variant="primary" onClick={() => { setEditing('new') }}>New agent</Button>
      </div>

      <ul className={css.list}>
        <li>
          <div className={clsx(css.row, settings.agentId === undefined && css.rowSelected)}>
            <button
              type="button"
              className={css.rowMain}
              onClick={() => { void settings.chooseAgent(null) }}
            >
              <span className={css.rowTitle}>Default assistant</span>
              <span className={css.rowMeta}>The built-in system prompt</span>
            </button>
            {settings.agentId === undefined && <IconCheckOutline16 />}
          </div>
        </li>
        {settings.agents.map(agent => (
          <li key={agent.id}>
            <div className={clsx(css.row, settings.agentId === agent.id && css.rowSelected)}>
              <button
                type="button"
                className={css.rowMain}
                onClick={() => { void settings.chooseAgent(agent.id) }}
              >
                <span className={css.rowTitle}>{agent.name}</span>
                <span className={css.rowMeta}>
                  {agent.description ?? 'No description'}
                  {agent.model === null ? '' : ` · ${agent.model}`}
                  {` · ${agent.mode}`}
                  {agent.groupId === null ? ' · shared' : ''}
                </span>
              </button>
              {settings.agentId === agent.id && <IconCheckOutline16 />}
              <Button
                variant="ghost"
                onClick={() => {
                  void settings.updateAgent(agent.id, { inTeam: agent.inTeam === 1 ? 0 : 1 })
                }}
              >
                {agent.inTeam === 1 ? 'In team' : 'Add to team'}
              </Button>
              <Button variant="ghost" onClick={() => { setEditing(agent) }}>Edit</Button>
              <button
                type="button"
                className={css.delete}
                aria-label={`Delete ${agent.name}`}
                onClick={() => { void settings.deleteAgent(agent.id) }}
              >
                <IconTrashOutline16 />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function McpEditor({ settings, onDone }: { settings: SettingsController; onDone: () => void }) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  const save = async () => {
    const failure = await settings.createMcpServer({
      name,
      transport,
      ...transport === 'stdio'
        ? { command, args: args.trim() === '' ? [] : args.trim().split(/\s+/) }
        : { url },
    })
    if (failure !== undefined) {
      setError(failure)
      return
    }
    onDone()
  }

  return (
    <div className={css.form}>
      <label className={css.field}>
        <span className={css.fieldLabel}>Name</span>
        <Input value={name} placeholder="filesystem" onChange={(e) => { setName(e.target.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>Transport</span>
        <select
          className={css.select}
          value={transport}
          onChange={(e) => { setTransport(e.target.value as 'stdio' | 'http') }}
        >
          <option value="stdio">stdio (spawn a command)</option>
          <option value="http">http (streamable endpoint)</option>
        </select>
      </label>
      {transport === 'stdio'
        ? (
          <>
            <label className={css.field}>
              <span className={css.fieldLabel}>Command</span>
              <Input value={command} placeholder="npx" onChange={(e) => { setCommand(e.target.value) }} />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>Arguments</span>
              <Input
                value={args}
                placeholder="-y @modelcontextprotocol/server-filesystem /path"
                onChange={(e) => { setArgs(e.target.value) }}
              />
              <span className={css.fieldHint}>Split on whitespace.</span>
            </label>
          </>
        )
        : (
          <label className={css.field}>
            <span className={css.fieldLabel}>URL</span>
            <Input value={url} placeholder="https://example.com/mcp" onChange={(e) => { setUrl(e.target.value) }} />
          </label>
        )}
      {error !== undefined && <p className={css.error}>{error}</p>}
      <div className={css.formActions}>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button variant="primary" disabled={name.trim() === ''} onClick={() => { void save() }}>
          Add server
        </Button>
      </div>
    </div>
  )
}

/**
 * MCP servers: register, enable, and see what each one exposes.
 * @param props - The settings controller.
 * @returns The MCP pane.
 */
export function McpPane({ settings }: { settings: SettingsController }) {
  const [adding, setAdding] = useState(false)
  if (adding) return <McpEditor settings={settings} onDone={() => { setAdding(false) }} />

  const statusOf = (server: McpServerRow) => settings.mcpStatuses.find(entry => entry.id === server.id)

  return (
    <div className={css.pane}>
      <div className={css.paneHead}>
        <p className={css.muted}>
          Tools from an enabled server join the workspace tools for every run in this group.
          A workspace tool always wins a name clash.
        </p>
        <Button variant="primary" onClick={() => { setAdding(true) }}>Add server</Button>
      </div>

      <ul className={css.list}>
        {settings.mcpServers.length === 0 && <li className={css.muted}>No MCP servers yet.</li>}
        {settings.mcpServers.map((server) => {
          const status = statusOf(server)
          return (
            <li key={server.id}>
              <div className={css.row}>
                <StateDot state={status?.connected === true ? 'done' : status?.error === undefined ? 'warning' : 'error'} />
                <div className={css.rowMain}>
                  <span className={css.rowTitle}>{server.name}</span>
                  <span className={css.rowMeta}>
                    {server.transport === 'stdio' ? `${server.command ?? ''} ${server.args ?? ''}` : server.url}
                  </span>
                  {status?.error !== undefined && <span className={css.errorText}>{status.error}</span>}
                  {status?.connected === true && (
                    <span className={css.rowMeta}>{status.toolCount} tools</span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void settings.updateMcpServer(server.id, { enabled: server.enabled === 1 ? 0 : 1 })
                  }}
                >
                  {server.enabled === 1 ? 'Disable' : 'Enable'}
                </Button>
                <button
                  type="button"
                  className={css.delete}
                  aria-label={`Delete ${server.name}`}
                  onClick={() => { void settings.deleteMcpServer(server.id) }}
                >
                  <IconTrashOutline16 />
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * The project's `AGENTS.md` files, as the runtime reads them.
 *
 * Read-only on purpose: the files belong to the project and are edited there.
 * What cannot be answered from the project is whether they are actually IN the
 * prompt — the SDK delivers them as an always-on context section, which is
 * silent by design, and a convention file being read invisibly looks exactly
 * like one being ignored.
 * @param props - The settings controller.
 * @returns The project-instructions pane.
 */
export function InstructionsPane({ settings }: { settings: SettingsController }) {
  const found = settings.instructions
  const files = found?.files ?? []

  return (
    <div className={css.pane}>
      <p className={css.muted}>
        An <code>AGENTS.md</code> file states the project&apos;s conventions. Unlike a skill,
        it is always on: every agent in this project reads it before every model round, and
        the SDK re-reads it while the run is in progress, so an edit lands on the next round
        without restarting the conversation.
      </p>
      <p className={css.muted}>
        Files are read broad-to-specific from the project folder down, and a directory the
        agent reaches into mid-run contributes its own file from that point on — those are
        not listed here, because they depend on what the agent has opened so far.
        <code> AGENTS.override.md</code> wins over <code>AGENTS.md</code> in the same folder.
      </p>

      <ul className={css.list}>
        {found === undefined && <li className={css.muted}>Loading…</li>}
        {found !== undefined && files.length === 0 && (
          <li className={css.muted}>
            No instruction file yet. Create <code>{`${found.workspaceRoot}/AGENTS.md`}</code>
            {' '}and it is picked up on the next model round.
          </li>
        )}
        {files.map(file => (
          <li key={file.absolutePath}>
            <div className={css.row}>
              <StateDot state="done" />
              <div className={css.rowMain}>
                <span className={css.rowTitle}>
                  {file.path}
                  {file.global === true ? ' (global)' : ''}
                </span>
                <span className={css.rowMeta}>
                  {`${String(Math.max(1, Math.round(file.bytes / 1024)))} KB`}
                  {file.firstLine === '' ? '' : ` · ${file.firstLine}`}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Skill roots: directories of SKILL.md folders discovered before each turn.
 * @param props - The settings controller.
 * @returns The skills pane.
 */
export function SkillsPane({ settings }: { settings: SettingsController }) {
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')

  const rowOf = (skill: SkillRow) => (
    <div className={css.row} key={skill.id}>
      <StateDot state={skill.enabled === 1 ? 'done' : 'warning'} />
      <div className={css.rowMain}>
        <span className={css.rowTitle}>{skill.name}</span>
        <span className={css.rowMeta}>{skill.rootPath}</span>
      </div>
      <Button
        variant="ghost"
        onClick={() => { void settings.updateSkill(skill.id, { enabled: skill.enabled === 1 ? 0 : 1 }) }}
      >
        {skill.enabled === 1 ? 'Disable' : 'Enable'}
      </Button>
      <button
        type="button"
        className={css.delete}
        aria-label={`Delete ${skill.name}`}
        onClick={() => { void settings.deleteSkill(skill.id) }}
      >
        <IconTrashOutline16 />
      </button>
    </div>
  )

  return (
    <div className={css.pane}>
      <p className={css.muted}>
        A skill is a folder holding a <code>SKILL.md</code>. The agent sees each skill&apos;s
        name and description, then calls <code>load_skill</code> to read the full instructions
        on demand.
      </p>
      <p className={css.muted}>
        Every project is scanned automatically: <code>.agents/skills</code> and
        <code> .dsh/skills</code> inside its folder, up to the repository root. The folders
        below are global — they are available in every project. Set
        <code> CHAT_AGENTS_USER_SKILLS=1</code> to also scan
        <code> $HOME/.agents/skills</code>.
      </p>

      <div className={css.inlineForm}>
        <Input value={name} placeholder="Name" onChange={(e) => { setName(e.target.value) }} />
        <Input
          value={rootPath}
          placeholder="/absolute/path/to/skills"
          onChange={(e) => { setRootPath(e.target.value) }}
        />
        <Button
          variant="primary"
          disabled={rootPath.trim() === ''}
          onClick={() => {
            void settings.createSkill({ name: name.trim(), rootPath: rootPath.trim() })
            setName('')
            setRootPath('')
          }}
        >
          Add
        </Button>
      </div>

      <ul className={css.list}>
        {settings.skills.length === 0 && <li className={css.muted}>No skill roots yet.</li>}
        {settings.skills.map(skill => <li key={skill.id}>{rowOf(skill)}</li>)}
      </ul>
    </div>
  )
}
