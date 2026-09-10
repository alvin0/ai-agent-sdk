'use client'

/**
 * What the deployment says about itself.
 *
 * Read once, at the top of the tree, because three things downstream depend on
 * it and each of them would otherwise fetch it again: the model catalog seeds
 * from the suggested ids, the composer offers the reasoning levels, and the key
 * banner needs to know whether the deployment holds a key of its own.
 */

import { useEffect, useState } from 'react'
import type { HealthBody } from '../server/wire'

/**
 * Fetch `/api/health` once.
 * @returns The body, or undefined until it answers.
 */
export function useHealth(): HealthBody | undefined {
  const [health, setHealth] = useState<HealthBody | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void fetch('/api/health')
      .then(response => (response.ok ? (response.json() as Promise<HealthBody>) : undefined))
      .then((body) => { if (!cancelled && body !== undefined) setHealth(body) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  return health
}
