'use client'

/**
 * Theme preference: `system` follows the OS, the other two pin it. The tokens
 * live on `body`, and dark is `body[data-ds-dark-theme]`, so applying a theme
 * is one attribute toggle.
 */

import { useCallback, useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

const THEME_KEY = 'chat-agents.theme'

function apply(preference: ThemePreference): void {
  const dark = preference === 'dark'
    || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

export interface ThemeController {
  readonly preference: ThemePreference
  readonly dark: boolean
  set: (preference: ThemePreference) => void
  toggle: () => void
}

/**
 * Read, apply, and persist the theme preference.
 * @returns The preference plus the resolved dark flag.
 */
export function useTheme(): ThemeController {
  const [preference, setPreference] = useState<ThemePreference>('system')
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY) as ThemePreference | null
    const initial = stored ?? 'system'
    setPreference(initial)
    apply(initial)
    setDark(document.body.hasAttribute('data-ds-dark-theme'))
  }, [])

  // `system` must track the OS while the tab stays open.
  useEffect(() => {
    if (preference !== 'system') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      apply('system')
      setDark(query.matches)
    }
    query.addEventListener('change', onChange)
    return () => { query.removeEventListener('change', onChange) }
  }, [preference])

  const set = useCallback((next: ThemePreference) => {
    setPreference(next)
    window.localStorage.setItem(THEME_KEY, next)
    apply(next)
    setDark(document.body.hasAttribute('data-ds-dark-theme'))
  }, [])

  const toggle = useCallback(() => {
    set(document.body.hasAttribute('data-ds-dark-theme') ? 'light' : 'dark')
  }, [set])

  return { preference, dark, set, toggle }
}
