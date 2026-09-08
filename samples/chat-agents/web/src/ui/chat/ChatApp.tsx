'use client'

/** The client boundary: one conversation inside the application shell. */

import { useState } from 'react'
import { AppShell } from '../layout/AppShell'
import { ProjectDialog } from '../settings/ProjectDialog'
import { SettingsDialog } from '../settings/SettingsDialog'
import { useSettings } from '../settings/useSettings'
import { useTheme } from '../settings/theme'
import { ChatView } from './ChatView'
import { useChat } from './useChat'

export function ChatApp() {
  const chat = useChat()
  const settings = useSettings(chat.sessionId, chat.groupId)
  const theme = useTheme()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  // With no explicit choice the backend runs the first ready provider, so the
  // badge says "Auto" rather than implying nothing is configured.
  const modelLabel = settings.choice === undefined
    ? 'Auto model'
    : `${settings.choice.provider} · ${settings.choice.model}`

  return (
    <>
      <AppShell
        conversations={chat.conversations}
        groups={chat.groups}
        groupId={chat.groupId}
        onOpenGroup={chat.openGroup}
        onManageProjects={() => { setProjectsOpen(true) }}
        currentId={chat.sessionId}
        runningIds={chat.runningIds}
        onNewChat={chat.newConversation}
        onOpenConversation={chat.openConversation}
        onDeleteConversation={(id) => { void chat.removeConversation(id) }}
        onOpenSettings={() => { setSettingsOpen(true) }}
        modelLabel={modelLabel}
        dark={theme.dark}
        onToggleTheme={theme.toggle}
      >
        <ChatView
          chat={chat}
          settings={settings}
          title={chat.conversations.find(row => row.id === chat.sessionId)?.title ?? 'New chat'}
          modelLabel={modelLabel}
          workspace={settings.workspace}
          onOpenSettings={() => { setSettingsOpen(true) }}
        />
      </AppShell>

      <ProjectDialog
        open={projectsOpen}
        onClose={() => { setProjectsOpen(false) }}
        projects={chat.groups}
        currentId={chat.groupId}
        browse={settings.browse}
        onOpenProject={chat.openGroup}
        onCreateProject={chat.createGroup}
        onDeleteProject={chat.deleteGroup}
        onMoveProject={settings.chooseWorkspace}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false) }}
        settings={settings}
        theme={theme}
      />
    </>
  )
}
