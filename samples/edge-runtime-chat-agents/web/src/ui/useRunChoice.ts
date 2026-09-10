'use client'

/**
 * What the page runs with: model, reasoning effort, mode, and the roster.
 *
 * Held in `localStorage` rather than on the server, for the same reason the key
 * is: an Edge isolate has nowhere to keep a per-visitor preference, and none of
 * this is a secret.
 *
 * Model and effort start unset, which means "whatever the deployment
 * configured". That matters for effort in particular: a model that does not
 * reason rejects the field outright, so asking for a level has to be a choice
 * somebody made.
 */

import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_TEAM, MEMBER_NAME, type RunMode, type WireMember } from '../server/wire'

const MODEL_STORE = 'edge-chat-agents.model'
const EFFORT_STORE = 'edge-chat-agents.effort'
const MODE_STORE = 'edge-chat-agents.mode'
const TEAM_STORE = 'edge-chat-agents.team'

export interface RunChoiceController {
  /** The chosen model, or undefined to follow the deployment's default. */
  readonly model: string | undefined
  /** The chosen reasoning level, or undefined to send none. */
  readonly effort: string | undefined
  /** Undefined follows the deployment's default mode from `/api/health`. */
  readonly mode: RunMode | undefined
  readonly team: readonly WireMember[]
  /** Whether the first read of `localStorage` has happened. */
  readonly ready: boolean
  setModel: (value: string | undefined) => void
  setEffort: (value: string | undefined) => void
  setMode: (value: RunMode) => void
  setTeam: (value: readonly WireMember[]) => void
}

/**
 * Read and store what the next run uses.
 * @returns The choice and its setters.
 */
export function useRunChoice(): RunChoiceController {
  const [model, setModelState] = useState<string | undefined>(undefined)
  const [effort, setEffortState] = useState<string | undefined>(undefined)
  const [mode, setModeState] = useState<RunMode | undefined>(undefined)
  const [team, setTeamState] = useState<readonly WireMember[]>(DEFAULT_TEAM)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      setModelState(readText(MODEL_STORE))
      setEffortState(readText(EFFORT_STORE))
      const storedMode = readText(MODE_STORE)
      setModeState(storedMode === 'team' || storedMode === 'team-auto' || storedMode === 'single'
        ? storedMode
        : undefined)
      const stored = readTeam()
      if (stored !== undefined) setTeamState(stored)
    } catch { /* a disabled store simply holds no preference */ }
    setReady(true)
  }, [])

  const setModel = useCallback((value: string | undefined) => {
    setModelState(value)
    writeText(MODEL_STORE, value)
  }, [])

  const setEffort = useCallback((value: string | undefined) => {
    setEffortState(value)
    writeText(EFFORT_STORE, value)
  }, [])

  const setMode = useCallback((value: RunMode) => {
    setModeState(value)
    writeText(MODE_STORE, value)
  }, [])

  const setTeam = useCallback((value: readonly WireMember[]) => {
    setTeamState(value)
    try { window.localStorage.setItem(TEAM_STORE, JSON.stringify(value)) }
    catch { /* held for this tab only */ }
  }, [])

  return { model, effort, mode, team, ready, setModel, setEffort, setMode, setTeam }
}

function readText(key: string): string | undefined {
  const value = window.localStorage.getItem(key)
  return value === null || value === '' ? undefined : value
}

function writeText(key: string, value: string | undefined): void {
  try {
    if (value === undefined) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch { /* held for this tab only */ }
}

/**
 * The stored roster, if it is still one the server would accept.
 *
 * A roster written by an older version of the page, or edited by hand, would
 * otherwise fail every send with a validation error the reader cannot connect
 * to anything they did. Falling back to the default is recoverable; a wedged
 * conversation is not.
 * @returns The roster, or undefined to keep the default.
 */
function readTeam(): readonly WireMember[] | undefined {
  const raw = window.localStorage.getItem(TEAM_STORE)
  if (raw === null) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return undefined }
  if (!Array.isArray(parsed) || parsed.length < 2) return undefined
  const members = parsed.filter((member): member is WireMember => {
    const name = member === null || typeof member !== 'object'
      ? undefined
      : Reflect.get(member, 'name')
    return typeof name === 'string' && MEMBER_NAME.test(name)
  })
  return members.length === parsed.length ? members : undefined
}
