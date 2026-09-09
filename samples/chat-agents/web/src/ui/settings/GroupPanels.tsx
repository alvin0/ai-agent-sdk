'use client'

/**
 * The panes for agent presets, MCP servers, and skills.
 *
 * Scope is a property of the ROW, not of the pane: every one of these tables
 * carries a nullable `group_id`, and the API writes null — visible in every
 * project — unless the caller asks for `projectOnly`. So an agent or a skill
 * root can be shared or pinned to one project, and the editor says which.
 */

import { useState } from 'react'
import clsx from 'clsx'
import type { AgentRow, McpServerRow, SkillRow } from '@chat-agents/backend'
import { Button, IconCheckOutline16, IconTrashOutline16, Input, StateDot } from '../primitives'
import type { SettingsController } from './useSettings'
import { HelpNote } from './HelpNote'
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
  /**
   * Where the preset shows up.
   *
   * A new preset defaults to the project being edited, because that is the
   * project the user is looking at; an existing one keeps whatever it has.
   */
  const [projectOnly, setProjectOnly] = useState(
    agent === undefined ? true : agent.groupId !== null,
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
    if (agent === undefined) await settings.createAgent({ ...payload, projectOnly })
    // A saved preset moves between scopes by rewriting the column: null is
    // every project, the group id is this one.
    else {
      await settings.updateAgent(agent.id, {
        ...payload,
        groupId: projectOnly ? settings.groupId : null,
      })
    }
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
        <label className={css.field}>
          <span className={css.fieldLabel}>Available in</span>
          <select
            className={css.select}
            value={projectOnly ? 'project' : 'all'}
            onChange={(e) => { setProjectOnly(e.target.value === 'project') }}
          >
            <option value="project">This project only</option>
            <option value="all">All projects</option>
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
 * @param props.settings - The controller for the project being edited.
 * @param props.canSelect - Whether a preset can be made the active one, which
 * is conversation state and so only applies to the project that has one open.
 * @returns The agents pane.
 */
export function AgentsPane({
  settings,
  canSelect = true,
}: {
  settings: SettingsController
  canSelect?: boolean
}) {
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
        <HelpNote
          summary={canSelect
            ? 'Presets for this project. The conversation runs the one you select.'
            : 'Presets for this project. Open the project to run one.'}
          label="How agent presets and team mode work"
        >
          <p>
            An agent preset replaces the system prompt and can pin its own model, loop policy,
            and effort.
          </p>
          <p>
            Each preset is scoped by its <strong>Available in</strong> setting: pinned to this
            project, or shared with every project. A shared one is marked <strong>shared</strong>
            {' '}in the list below.
          </p>
          <p>
            In <strong>Team</strong> mode the selected preset leads, delegating to every preset
            marked <strong>In team</strong>. <strong>Team · auto</strong> ignores the roster and
            lets the lead spawn its own workers.
          </p>
        </HelpNote>
        <Button variant="primary" onClick={() => { setEditing('new') }}>New agent</Button>
      </div>

      <ul className={css.list}>
        {canSelect && (
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
        )}
        {settings.agents.map(agent => (
          <li key={agent.id}>
            <div className={clsx(css.row, canSelect && settings.agentId === agent.id && css.rowSelected)}>
              <button
                type="button"
                className={css.rowMain}
                disabled={!canSelect}
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
              {canSelect && settings.agentId === agent.id && <IconCheckOutline16 />}
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
 *
 * Global, not per project: the create route writes a null `group_id` unless
 * asked otherwise, and this pane never asks — so a server registered once is
 * reachable from every project.
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
        <HelpNote
          summary="Servers are shared by every project. Tools from an enabled one join every run."
          label="How MCP tools reach a run"
        >
          <p>
            A server registered here is available in every project. Tools from an enabled server
            join the workspace tools for every run, and a workspace tool always wins a name clash.
          </p>
        </HelpNote>
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
      <div className={css.paneHead}>
        <HelpNote
          summary="What this project can load, and the extra folders it looks in."
          label="How skills are discovered"
        >
          <p>
            A skill is a folder holding a <code>SKILL.md</code>. The agent sees each skill&apos;s
            name and description, then calls <code>load_skill</code> to read the full instructions
            on demand.
          </p>
          <p>
            Every project is scanned automatically: <code>.agents/skills</code> and
            <code> .dsh/skills</code> inside its folder, up to the repository root. The folders
            below are global — they are available in every project. Set
            <code> CHAT_AGENTS_USER_SKILLS=1</code> to also scan
            <code> $HOME/.agents/skills</code>.
          </p>
        </HelpNote>
      </div>

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

      {/*
        What a run would actually find, read from the same catalogue the
        composer's `/` menu uses — so the pane can never advertise a skill the
        run would miss, or hide one it would pick up.
      */}
      <span className={css.groupLabel}>Available in this project</span>
      <ul className={css.list}>
        {settings.availableSkills.length === 0 && (
          <li className={css.muted}>
            Nothing found yet. Add a folder above, or create <code>.agents/skills</code> in the
            project.
          </li>
        )}
        {settings.availableSkills.map(skill => (
          <li key={skill.id}>
            <div className={css.row}>
              <StateDot state="done" />
              <div className={css.rowMain}>
                <span className={css.rowTitle}>{skill.name}</span>
                <span className={css.rowMeta}>
                  {skill.description}
                </span>
              </div>
              <span className={css.rowMeta}>{skill.provider}</span>
            </div>
          </li>
        ))}
      </ul>

      <span className={css.groupLabel}>Folders you added</span>
      <ul className={css.list}>
        {settings.skills.length === 0 && <li className={css.muted}>No skill roots yet.</li>}
        {settings.skills.map(skill => <li key={skill.id}>{rowOf(skill)}</li>)}
      </ul>
    </div>
  )
}
