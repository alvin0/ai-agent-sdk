'use client'

/**
 * Local transcript cache.
 *
 * SQLite on the backend is the authority; IndexedDB here makes a reopened
 * conversation paint instantly and survive an offline reload. Every read
 * tolerates a missing or blocked database — a private window must still work.
 */

import type { ChatNode } from './types'

const DB_NAME = 'chat-agents'
const DB_VERSION = 1
const STORE = 'transcripts'

interface CachedTranscript {
  id: string
  nodes: ChatNode[]
  updatedAt: number
}

function open(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(undefined)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { resolve(undefined) }
    request.onblocked = () => { resolve(undefined) }
  })
}

/**
 * Read one conversation's cached transcript.
 * @param id - Conversation id.
 * @returns The cached nodes, or undefined when nothing is cached.
 */
export async function readTranscript(id: string): Promise<readonly ChatNode[] | undefined> {
  const db = await open()
  if (db === undefined) return undefined
  return new Promise((resolve) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id)
    request.onsuccess = () => {
      const value = request.result as CachedTranscript | undefined
      resolve(value?.nodes)
    }
    request.onerror = () => { resolve(undefined) }
  })
}

/**
 * Cache one conversation's transcript.
 * @param id - Conversation id.
 * @param nodes - The rendered nodes.
 */
export async function writeTranscript(id: string, nodes: readonly ChatNode[]): Promise<void> {
  const db = await open()
  if (db === undefined) return
  await new Promise<void>((resolve) => {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    const request = store.put({ id, nodes: [...nodes], updatedAt: Date.now() } satisfies CachedTranscript)
    request.onsuccess = () => { resolve() }
    request.onerror = () => { resolve() }
  })
}

/**
 * Drop one conversation's cache.
 * @param id - Conversation id.
 */
export async function deleteTranscript(id: string): Promise<void> {
  const db = await open()
  if (db === undefined) return
  await new Promise<void>((resolve) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)
    request.onsuccess = () => { resolve() }
    request.onerror = () => { resolve() }
  })
}
