'use client'

/**
 * The visitor's own API key, held in `localStorage`.
 *
 * Understand what this is before shipping it. A key in `localStorage` is
 * readable by any script that ends up on this origin, and it travels from the
 * browser on every run. That is an acceptable trade for a sample someone runs
 * with their own key against their own deployment, and a bad one for an app
 * serving other people — there, the key belongs in the deployment's
 * environment and the page should never see it. This module exists because the
 * first case is what a sample is for; `configured` on `/api/health` is how the
 * UI knows the second case already applies and no key is being asked for.
 *
 * The key is never rendered back in full: the dialog shows only its last four
 * characters once it has been saved.
 */

import { useCallback, useEffect, useState } from 'react'

const KEY_STORE = 'edge-chat-agents.apiKey'

export interface ApiKeyController {
  /** The stored key, or undefined when the browser holds none. */
  readonly key: string | undefined
  /** Whether the first read of `localStorage` has happened. */
  readonly ready: boolean
  save: (value: string) => void
  clear: () => void
}

/**
 * Read, store, and clear the browser-held API key.
 * @returns The key and the two actions over it.
 */
export function useApiKey(): ApiKeyController {
  const [key, setKey] = useState<string | undefined>(undefined)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(KEY_STORE)
      if (stored !== null && stored !== '') setKey(stored)
    } catch { /* a disabled store simply holds no key */ }
    setReady(true)
  }, [])

  const save = useCallback((value: string) => {
    const trimmed = value.trim()
    if (trimmed === '') return
    setKey(trimmed)
    try { window.localStorage.setItem(KEY_STORE, trimmed) } catch { /* held for this tab only */ }
  }, [])

  const clear = useCallback(() => {
    setKey(undefined)
    try { window.localStorage.removeItem(KEY_STORE) } catch { /* nothing to remove */ }
  }, [])

  return { key, ready, save, clear }
}

/**
 * The tail of a key, for showing that one is stored without revealing it.
 * @param key - The stored key.
 * @returns A masked label, or undefined when there is no key.
 */
export function keyHint(key: string | undefined): string | undefined {
  return key === undefined ? undefined : `••••${key.slice(-4)}`
}
