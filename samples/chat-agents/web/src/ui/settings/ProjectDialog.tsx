'use client'

/**
 * Projects.
 *
 * A project IS a folder: pick a directory and that becomes the project's
 * workspace, its name, and the scope every conversation inside it runs in.
 * The browser runs server-side because a web page cannot hand over a real path.
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { DirectoryListing, GroupRow } from '@chat-agents/backend'
import {
  Button, IconCheckOutline16, IconChevronRightOutline14, IconChevronUpOutline14,
  IconEditOutline16, IconFolderClose16, IconFolderOpen16, IconSearchOutline16,
  IconTrashOutline16, Modal,
} from '../primitives'
import css from './ProjectDialog.module.css'

export interface ProjectDialogProps {
  open: boolean
  onClose: () => void
  projects: readonly GroupRow[]
  currentId: string
  /** Browse one directory server-side; undefined starts at the user's home. */
  browse: (path?: string) => Promise<DirectoryListing | undefined>
  onOpenProject: (id: string) => void
  onCreateProject: (workspaceRoot: string) => Promise<unknown>
  onDeleteProject: (id: string) => Promise<void>
  /** Repoint the open project at another folder. */
  onMoveProject: (workspaceRoot: string) => Promise<unknown>
}

/**
 * Render the project switcher and folder picker.
 * @param props - Project list plus the browse and mutation callbacks.
 * @returns The dialog, or null while closed.
 */
export function ProjectDialog({
  open,
  onClose,
  projects,
  currentId,
  browse,
  onOpenProject,
  onCreateProject,
  onDeleteProject,
  onMoveProject,
}: ProjectDialogProps) {
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** Substring filter over the listed names; reset on every navigation. */
  const [filter, setFilter] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  /** The typed path, or undefined while the breadcrumb is showing. */
  const [typed, setTyped] = useState<string | undefined>(undefined)
  const crumbs = useRef<HTMLDivElement | null>(null)

  const load = async (path?: string) => {
    setBusy(true)
    const next = await browse(path)
    // A path that cannot be read leaves the current listing in place: dropping
    // to an empty picker would lose the user's position for a typo.
    setError(next === undefined ? `Cannot open ${path ?? 'that folder'}` : undefined)
    if (next !== undefined) {
      setListing(next)
      setFilter('')
      setTyped(undefined)
    }
    setBusy(false)
  }

  useEffect(() => {
    if (!open) return
    const open_at = projects.find(project => project.id === currentId)?.workspaceRoot
    void load(open_at)
    // The picker re-opens where the current project lives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // The breadcrumb scrolls horizontally and the interesting end is the right
  // one, so a deep path opens showing the folder you are actually in.
  useEffect(() => {
    const element = crumbs.current
    if (element !== null) element.scrollLeft = element.scrollWidth
  }, [listing?.path])

  const current = projects.find(project => project.id === currentId)
  const alreadyAProject = listing !== undefined
    && projects.some(project => project.workspaceRoot === listing.path)

  const needle = filter.trim().toLowerCase()
  const visible = (listing?.entries ?? []).filter(entry =>
    (showHidden || !entry.hidden)
    && (needle === '' || entry.name.toLowerCase().includes(needle)))
  const hiddenCount = (listing?.entries ?? []).filter(entry => entry.hidden).length

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Projects"
      closeLabel="Close"
      description="A project is a folder. Everything an agent reads stays inside it."
      className={css.dialog}
    >
      <div className={css.layout}>
        <div className={css.column}>
          <span className={css.label}>Your projects</span>
          <ul className={css.projectList}>
            {projects.map(project => (
              <li key={project.id}>
                <div className={clsx(css.project, project.id === currentId && css.projectActive)}>
                  <button
                    type="button"
                    className={css.projectOpen}
                    onClick={() => {
                      onOpenProject(project.id)
                      onClose()
                    }}
                  >
                    <span className={css.projectName}>
                      {project.name}
                      {project.id === currentId && <IconCheckOutline16 />}
                    </span>
                    <span className={css.path}>{project.workspaceRoot}</span>
                  </button>
                  {project.id !== 'default' && (
                    <button
                      type="button"
                      className={css.delete}
                      aria-label={`Remove ${project.name}`}
                      onClick={() => { void onDeleteProject(project.id) }}
                    >
                      <IconTrashOutline16 />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className={css.column}>
          <span className={css.label}>Choose a folder</span>
          <div className={css.browser}>
            <div className={css.browserHead}>
              <button
                type="button"
                className={css.headButton}
                aria-label="Up one level"
                disabled={listing?.parent === undefined}
                onClick={() => { void load(listing?.parent) }}
              >
                <IconChevronUpOutline14 />
              </button>
              {typed === undefined
                ? (
                  <div className={css.crumbs} ref={crumbs}>
                    {(listing?.segments ?? []).map((segment, index) => (
                      <span className={css.crumbSlot} key={segment.path}>
                        {index > 0 && <span className={css.crumbSep}>{'›'}</span>}
                        <button
                          type="button"
                          className={clsx(
                            css.crumb,
                            segment.path === listing?.path && css.crumbCurrent,
                          )}
                          onClick={() => { void load(segment.path) }}
                        >
                          {segment.name}
                        </button>
                      </span>
                    ))}
                  </div>
                )
                : (
                  <input
                    className={css.pathInput}
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    spellCheck={false}
                    aria-label="Folder path"
                    placeholder="Paste or type a folder path"
                    value={typed}
                    onChange={(event) => { setTyped(event.target.value) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && typed.trim() !== '') void load(typed.trim())
                      if (event.key === 'Escape') setTyped(undefined)
                    }}
                  />
                )}
              <button
                type="button"
                className={clsx(css.headButton, typed !== undefined && css.headButtonActive)}
                aria-label={typed === undefined ? 'Type a path' : 'Back to the breadcrumb'}
                title="Type or paste a path"
                onClick={() => { setTyped(shown => (shown === undefined ? listing?.path ?? '' : undefined)) }}
              >
                <IconEditOutline16 />
              </button>
            </div>

            <div className={css.browserTools}>
              <span className={css.filterField}>
                <IconSearchOutline16 />
                <input
                  className={css.filterInput}
                  aria-label="Filter folders"
                  placeholder="Filter this folder…"
                  value={filter}
                  onChange={(event) => { setFilter(event.target.value) }}
                />
              </span>
              {(listing?.roots ?? []).length > 1 && (listing?.roots ?? []).map(root => (
                <button
                  type="button"
                  key={root.path}
                  className={clsx(css.chip, listing?.path.startsWith(root.path) && css.chipActive)}
                  onClick={() => { void load(root.path) }}
                >
                  {root.name.replace(/[\\/]+$/, '')}
                </button>
              ))}
              <button type="button" className={css.chip} onClick={() => { void load(undefined) }}>
                Home
              </button>
              {hiddenCount > 0 && (
                <label className={css.toggle}>
                  <input
                    type="checkbox"
                    checked={showHidden}
                    onChange={(event) => { setShowHidden(event.target.checked) }}
                  />
                  {`Hidden (${String(hiddenCount)})`}
                </label>
              )}
            </div>

            {error !== undefined && <p className={css.error}>{error}</p>}

            <ul className={css.dirList}>
              {busy && <li className={css.muted}>Loading…</li>}
              {!busy && visible.length === 0 && (
                <li className={css.muted}>
                  {needle !== ''
                    ? 'No folder matches that filter.'
                    : 'No subfolders here — pick this folder, or go up.'}
                </li>
              )}
              {!busy && visible.map(entry => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={clsx(css.dirItem, entry.hidden && css.dirItemHidden)}
                    onClick={() => { void load(entry.path) }}
                  >
                    <IconFolderClose16 />
                    <span className={css.dirName}>{entry.name}</span>
                    <IconChevronRightOutline14 className={css.dirChevron} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className={css.pickerActions}>
            <Button
              variant="ghost"
              disabled={listing === undefined || listing.path === current?.workspaceRoot}
              onClick={() => {
                if (listing === undefined) return
                void onMoveProject(listing.path)
                onClose()
              }}
            >
              Move “{current?.name ?? 'project'}” here
            </Button>
            <Button
              variant="primary"
              icon={<IconFolderOpen16 />}
              disabled={listing === undefined || alreadyAProject}
              onClick={() => {
                if (listing === undefined) return
                void onCreateProject(listing.path)
                onClose()
              }}
            >
              {alreadyAProject ? 'Already a project' : 'Open as a new project'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
