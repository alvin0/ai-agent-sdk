'use client'

/**
 * The composer's draft attachments: intake, upload, and the order they keep.
 *
 * Files upload the moment they are picked, not when the message is sent. A
 * 15 MB screenshot that only starts uploading on Enter makes send feel broken
 * for the seconds it takes; uploading on pick spends that time while the user
 * is still typing, and gives every file its own progress and its own retry, so
 * one failure in a batch of six does not lose the other five.
 *
 * `XMLHttpRequest` rather than `fetch` for exactly one reason: fetch cannot
 * report upload progress, and a file card with an indeterminate bar for twenty
 * seconds is the thing the progress is there to prevent.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { WireAttachment } from '@chat-agents/backend'

/** Raster types the backend admits as model input. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
])

/**
 * Limits the composer enforces before uploading.
 *
 * Seeded with the backend's own defaults and replaced by what `/api/attachments/limits`
 * reports, so a refusal the user sees is the refusal the server would have made.
 */
export interface AttachmentLimits {
  readonly maxImageBytes: number
  readonly maxFileBytes: number
  readonly maxPerMessage: number
}

const DEFAULT_LIMITS: AttachmentLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxPerMessage: 20,
}

/** Upload lifecycle of one picked file. */
export type DraftUpload =
  | { readonly status: 'uploading'; readonly loaded: number; readonly total: number }
  | { readonly status: 'ready'; readonly record: WireAttachment }
  | { readonly status: 'error'; readonly message: string }

/** One attachment in the composer, before the message is sent. */
export interface DraftAttachment {
  /** Browser-owned draft identity; the durable id lives on a ready upload. */
  readonly id: string
  readonly file: File
  readonly kind: 'image' | 'file'
  /** Object URL of the local file, for images only. */
  readonly previewUrl?: string
  readonly upload: DraftUpload
}

/** What the composer needs to draw and drive its attachments. */
export interface AttachmentsController {
  readonly items: readonly DraftAttachment[]
  /** Whether one more file may be picked right now. */
  readonly canAccept: boolean
  /** True while any upload is still running; send waits on this. */
  readonly uploading: boolean
  /** Ids of every ready upload, in pick order. */
  readonly readyIds: readonly string[]
  /** The admission limits in force, as the backend reports them. */
  readonly limits: AttachmentLimits
  /** The last refusal, for the composer to show; null once dismissed. */
  readonly notice: string | null
  add: (files: readonly File[]) => void
  remove: (id: string) => void
  retry: (id: string) => void
  /**
   * Drop the drafts a sent message carried.
   *
   * A failed upload is deliberately kept: it did NOT go with the message, and
   * clearing it too would remove the only sign that the file never arrived.
   */
  clear: () => void
  dismissNotice: () => void
}

function draftId(): string {
  return `a_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Upload one file, reporting bytes as they go.
 * @param file - The picked file.
 * @param onProgress - Byte observer.
 * @param signal - Cancels the request when the draft is removed.
 * @returns The durable record the backend minted.
 */
function upload(
  file: File,
  onProgress: (loaded: number, total: number) => void,
  signal: AbortSignal,
): Promise<WireAttachment> {
  return new Promise<WireAttachment>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/api/attachments')
    request.responseType = 'json'
    // A name may hold anything a filesystem allows, including characters no
    // header may carry, so it travels percent-encoded and is decoded server-side.
    request.setRequestHeader('x-attachment-name', encodeURIComponent(file.name))
    request.setRequestHeader('content-type', file.type === '' ? 'application/octet-stream' : file.type)
    request.upload.onprogress = (event) => {
      onProgress(event.loaded, event.lengthComputable ? event.total : file.size)
    }
    request.onload = () => {
      const body = request.response as (WireAttachment & { error?: string }) | null
      if (request.status >= 200 && request.status < 300 && body !== null && body.error === undefined) {
        resolve(body)
        return
      }
      reject(new Error(body?.error ?? `upload failed (${String(request.status)})`))
    }
    request.onerror = () => { reject(new Error('the upload could not reach the server')) }
    request.onabort = () => { reject(new DOMException('aborted', 'AbortError')) }
    signal.addEventListener('abort', () => { request.abort() }, { once: true })
    request.send(file)
  })
}

/**
 * Drive the composer's attachment drafts.
 * @returns The controller the composer and its rail read.
 */
export function useAttachments(): AttachmentsController {
  const [items, setItems] = useState<readonly DraftAttachment[]>([])
  const [limits, setLimits] = useState<AttachmentLimits>(DEFAULT_LIMITS)
  const [notice, setNotice] = useState<string | null>(null)
  /** One controller per live upload, so removing a draft cancels its request. */
  const running = useRef(new Map<string, AbortController>())
  /** Object URLs still owed a revoke; a preview leaked per pick adds up fast. */
  const previews = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    void fetch('/api/attachments/limits')
      .then(async response => response.ok ? await response.json() as AttachmentLimits : null)
      .then((value) => { if (!cancelled && value !== null) setLimits(value) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  useEffect(() => () => {
    for (const controller of running.current.values()) controller.abort()
    for (const url of previews.current) URL.revokeObjectURL(url)
    previews.current.clear()
  }, [])

  const patch = useCallback((id: string, upload_: DraftUpload): void => {
    setItems(current => current.map(item => item.id === id ? { ...item, upload: upload_ } : item))
  }, [])

  const start = useCallback((draft: DraftAttachment): void => {
    const controller = new AbortController()
    running.current.set(draft.id, controller)
    void upload(
      draft.file,
      (loaded, total) => { patch(draft.id, { status: 'uploading', loaded, total }) },
      controller.signal,
    )
      .then((record) => { patch(draft.id, { status: 'ready', record }) })
      .catch((error: unknown) => {
        // A cancelled upload belongs to a draft that no longer exists; showing
        // it as failed would put a retry button on a card nobody can see.
        if (error instanceof DOMException && error.name === 'AbortError') return
        patch(draft.id, {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => { running.current.delete(draft.id) })
  }, [patch])

  const add = useCallback((files: readonly File[]): void => {
    if (files.length === 0) return
    const accepted: DraftAttachment[] = []
    let refusal: string | null = null
    for (const file of files) {
      if (items.length + accepted.length >= limits.maxPerMessage) {
        refusal = `one message may carry ${String(limits.maxPerMessage)} attachments`
        break
      }
      const kind = IMAGE_MEDIA_TYPES.has(file.type) ? 'image' : 'file'
      const cap = kind === 'image' ? limits.maxImageBytes : limits.maxFileBytes
      if (file.size > cap) {
        refusal = `"${file.name}" is ${sizeText(file.size)}; the limit is ${sizeText(cap)}`
        continue
      }
      if (file.size === 0) {
        refusal = `"${file.name}" is empty`
        continue
      }
      const previewUrl = kind === 'image' ? URL.createObjectURL(file) : undefined
      if (previewUrl !== undefined) previews.current.add(previewUrl)
      accepted.push({
        id: draftId(),
        file,
        kind,
        ...previewUrl === undefined ? {} : { previewUrl },
        upload: { status: 'uploading', loaded: 0, total: file.size },
      })
    }
    if (refusal !== null) setNotice(refusal)
    if (accepted.length === 0) return
    // Admission decided outside the state updater, deliberately: an updater
    // runs twice under StrictMode, and starting uploads inside one would send
    // every file to the server twice.
    setItems(current => [...current, ...accepted])
    for (const draft of accepted) start(draft)
  }, [items, limits, start])

  const remove = useCallback((id: string): void => {
    running.current.get(id)?.abort()
    running.current.delete(id)
    setItems((current) => {
      const found = current.find(item => item.id === id)
      if (found?.previewUrl !== undefined) {
        URL.revokeObjectURL(found.previewUrl)
        previews.current.delete(found.previewUrl)
      }
      return current.filter(item => item.id !== id)
    })
  }, [])

  const retry = useCallback((id: string): void => {
    const found = items.find(item => item.id === id)
    if (found === undefined || found.upload.status !== 'error') return
    patch(id, { status: 'uploading', loaded: 0, total: found.file.size })
    start(found)
  }, [items, patch, start])

  const clear = useCallback((): void => {
    setItems((current) => {
      for (const item of current) {
        if (item.upload.status === 'error' || item.previewUrl === undefined) continue
        URL.revokeObjectURL(item.previewUrl)
        previews.current.delete(item.previewUrl)
      }
      return current.filter(item => item.upload.status === 'error')
    })
  }, [])

  const dismissNotice = useCallback((): void => { setNotice(null) }, [])

  return {
    items,
    canAccept: items.length < limits.maxPerMessage,
    uploading: items.some(item => item.upload.status === 'uploading'),
    readyIds: items.flatMap(item => item.upload.status === 'ready' ? [item.upload.record.id] : []),
    limits,
    notice,
    add,
    remove,
    retry,
    clear,
    dismissNotice,
  }
}

export { sizeText as attachmentSizeText }
