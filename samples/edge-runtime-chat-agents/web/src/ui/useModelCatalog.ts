'use client'

/**
 * The models this browser knows about, and what each of them can hold.
 *
 * Kept in `localStorage` because the visitor is the only one who knows which
 * models their account can reach, and an Edge isolate has nowhere to remember
 * that for them. The catalog rides along with each run so the SDK can keep an
 * output cap inside the model's context window instead of guessing.
 *
 * Capacities are pre-filled from a built-in table wherever there is one, so
 * adding a known model is typing its id and nothing else.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  EFFORTS, MAX_CATALOG_MODELS, suggestedCapacity, suggestedEfforts, type WireModel,
} from '../server/wire'

const CATALOG_STORE = 'edge-chat-agents.catalog'

export interface ModelCatalogController {
  /** Every model the browser holds, in the order they were added. */
  readonly models: readonly WireModel[]
  readonly ready: boolean
  /** Add a model, or replace the entry for one already listed. */
  add: (model: WireModel) => void
  remove: (id: string) => void
  /** Whether this id can still be added: not listed, and there is room. */
  canAdd: (id: string) => boolean
}

/**
 * Read and edit the browser's model catalog.
 * @param suggested - Ids the server suggests, used to seed an empty catalog.
 * @returns The catalog and the actions over it.
 */
export function useModelCatalog(suggested: readonly string[]): ModelCatalogController {
  const [models, setModels] = useState<readonly WireModel[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let stored: readonly WireModel[] | undefined
    try { stored = read() } catch { /* a disabled store simply holds nothing */ }
    if (stored !== undefined) {
      // Catalog entries written before per-model efforts existed are still
      // valid. Enrich them in place so an existing browser immediately gets
      // the same effort menu as a fresh visit.
      const upgraded = stored.map(entry => entry.efforts === undefined
        ? { ...entry, efforts: suggestedEfforts(entry.id) }
        : entry)
      setModels(upgraded)
      if (upgraded.some((entry, index) => entry.efforts !== stored[index]?.efforts)) write(upgraded)
    }
    setReady(true)
  }, [])

  // An empty catalog is seeded from what the server suggests, so a first visit
  // has a usable list without anyone typing. Only once: a model removed here
  // must stay removed rather than reappearing on the next render.
  useEffect(() => {
    if (!ready || suggested.length === 0) return
    setModels((current) => {
      if (current.length > 0) return current
      const seeded = suggested.map(id => ({
        id,
        ...suggestedCapacity(id),
        efforts: suggestedEfforts(id),
      }))
      write(seeded)
      return seeded
    })
  }, [ready, suggested])

  const add = useCallback((model: WireModel) => {
    setModels((current) => {
      const rest = current.filter(entry => entry.id !== model.id)
      if (rest.length >= MAX_CATALOG_MODELS) return current
      const next = [...rest, model]
      write(next)
      return next
    })
  }, [])

  const remove = useCallback((id: string) => {
    setModels((current) => {
      const next = current.filter(entry => entry.id !== id)
      write(next)
      return next
    })
  }, [])

  const canAdd = useCallback((id: string) => (
    id !== '' && !models.some(entry => entry.id === id) && models.length < MAX_CATALOG_MODELS
  ), [models])

  return { models, ready, add, remove, canAdd }
}

function write(models: readonly WireModel[]): void {
  try { window.localStorage.setItem(CATALOG_STORE, JSON.stringify(models)) }
  catch { /* held for this tab only */ }
}

/**
 * The stored catalog, if it still looks like one.
 *
 * A catalog written by an older version of the page, or edited by hand, would
 * otherwise fail every send on a validation error the reader cannot connect to
 * anything they did. Dropping it is recoverable; a wedged conversation is not.
 * @returns The catalog, or undefined when there is nothing usable.
 */
function read(): readonly WireModel[] | undefined {
  const raw = window.localStorage.getItem(CATALOG_STORE)
  if (raw === null) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return undefined }
  if (!Array.isArray(parsed)) return undefined
  const models = parsed.filter((entry): entry is WireModel => {
    const id = entry === null || typeof entry !== 'object' ? undefined : Reflect.get(entry, 'id')
    const efforts = entry === null || typeof entry !== 'object' ? undefined : Reflect.get(entry, 'efforts')
    return typeof id === 'string' && id.length > 0
      && (efforts === undefined || Array.isArray(efforts)
        && efforts.every(value => typeof value === 'string' && EFFORTS.includes(value)))
  })
  return models.length === parsed.length ? models.slice(0, MAX_CATALOG_MODELS) : undefined
}
