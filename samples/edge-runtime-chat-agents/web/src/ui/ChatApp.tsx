'use client'

/** The client boundary: one conversation inside the application shell. */

import { useEffect, useState } from 'react'
import { AppShell } from './AppShell'
import { ChatView } from './ChatView'
import { TraceDialog } from './TraceDialog'
import { ComposerControls } from './ComposerControls'
import { SettingsDialog } from './SettingsDialog'
import { TeamDialog } from './TeamDialog'
import { useApiKey } from './useApiKey'
import { useChat } from './useChat'
import { useHealth } from './useHealth'
import { useModelCatalog } from './useModelCatalog'
import { useRunChoice } from './useRunChoice'
import { useTheme } from './theme'
import { effortsForModel as modelEffortsFor } from '../server/wire'

export function ChatApp() {
  const apiKey = useApiKey()
  const choice = useRunChoice()
  const health = useHealth()
  const mode = choice.mode ?? health?.mode ?? 'single'
  // The catalog seeds from what the deployment suggests, and the run needs the
  // catalog, so health is read here rather than inside the chat hook.
  const catalog = useModelCatalog(health?.models ?? [])
  const chat = useChat(apiKey.key, {
    model: choice.model,
    effort: choice.effort,
    mode,
    team: choice.team,
    catalog: catalog.models,
  })
  const theme = useTheme()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [teamOpen, setTeamOpen] = useState(false)
  const [traceOpen, setTraceOpen] = useState(false)

  // Before /api/health answers, the model is whatever the deployment says it
  // is, so the chip stays honest by naming nothing rather than a guess.
  const model = choice.model ?? health?.model ?? 'openai'
  const models = catalog.models.map(entry => entry.id)
  const efforts = modelEffortsFor(model, catalog.models)
  const effortKey = efforts.join(',')

  // A stored effort may belong to the model used on the previous visit. Clear
  // it once the current model metadata is available instead of sending an
  // effort that this model cannot accept.
  useEffect(() => {
    if (!catalog.ready || health === undefined || choice.effort === undefined) return
    if (!efforts.includes(choice.effort)) choice.setEffort(undefined)
  }, [catalog.ready, choice.effort, choice.setEffort, effortKey, health])
  const title = chat.conversations.find(row => row.id === chat.conversationId)?.title ?? 'New chat'
  const serverConfigured = health?.configured ?? false
  // Nothing can run until one of the two sources has a key. The browser's is
  // only known once localStorage has been read, so the banner waits for that
  // rather than flashing on every load.
  const needsKey = apiKey.ready && apiKey.key === undefined && health !== undefined
    && !serverConfigured

  return (
    <>
      <AppShell
        conversations={chat.conversations}
        currentId={chat.conversationId}
        runningIds={chat.runningIds}
        onNewChat={chat.newConversation}
        onOpenConversation={chat.openConversation}
        onDeleteConversation={chat.deleteConversation}
        modelLabel={mode === 'team'
          ? `team · ${String(choice.team.length)} agents`
          : mode === 'team-auto'
            ? 'team · auto'
            : choice.effort === undefined ? model : `${model} · ${choice.effort}`}
        hasKey={apiKey.key !== undefined}
        needsKey={needsKey}
        onOpenKey={() => { setSettingsOpen(true) }}
        dark={theme.dark}
        onToggleTheme={theme.toggle}
      >
        <ChatView
          chat={chat}
          title={title}
          keySource={apiKey.key !== undefined ? 'browser' : serverConfigured ? 'server' : 'none'}
          onOpenKey={() => { setSettingsOpen(true) }}
          onOpenTrace={() => { setTraceOpen(true) }}
          {...mode === 'team' ? { onEditTeam: () => { setTeamOpen(true) } } : {}}
          controls={(
            <ComposerControls
              models={models.length === 0 ? [model] : models}
              efforts={efforts}
              model={model}
              effort={choice.effort}
              mode={mode}
              onModel={choice.setModel}
              onEffort={choice.setEffort}
              onMode={choice.setMode}
              onEditTeam={() => { setTeamOpen(true) }}
            />
          )}
        />
      </AppShell>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false) }}
        apiKey={apiKey}
        catalog={catalog}
        serverConfigured={serverConfigured}
      />

      <TeamDialog
        open={teamOpen}
        onClose={() => { setTeamOpen(false) }}
        members={choice.team}
        onSave={choice.setTeam}
        models={models}
        effortsForModel={(memberModel) => modelEffortsFor(memberModel, catalog.models)}
        runModel={model}
        // Saving replaces the team on the server, and the conversation's
        // model-side history goes with the team that produced it.
        restarts={chat.nodes.length > 0}
      />

      <TraceDialog
        open={traceOpen}
        onClose={() => { setTraceOpen(false) }}
        conversationId={chat.conversationId}
        {...apiKey.key === undefined ? {} : { apiKey: apiKey.key }}
        liveRunId={chat.liveRunId}
        liveSpans={chat.liveSpans}
      />
    </>
  )
}
