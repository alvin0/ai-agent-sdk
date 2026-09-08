'use client'

/**
 * Everything the transcript shows about attachments: the composer's draft rail,
 * the page-wide drop invitation, the images inside a sent message, and the
 * lightbox that opens the original.
 *
 * Draft and sent attachments deliberately share their presentation. What the
 * user arranged under the composer is what appears in the message, in the same
 * order and at the same sizes, so sending never rearranges what was reviewed.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WireAttachment } from '@chat-agents/backend'
import {
  DocumentFileIcon, fileSizeText, IconCloseFill14, IconCloseOutline16, IconLoadingOutline16,
  IconRefreshOutline14,
} from '../primitives'
import type { AttachmentsController, DraftAttachment } from './useAttachments'
import css from './Attachments.module.css'

/** Where a stored attachment's bytes are served from. */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}`
}

/** The extension a card shows, uppercased, or the media type's subtype. */
function extensionOf(name: string, mediaType: string): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase()
  return (mediaType.split('/')[1] ?? 'FILE').toUpperCase()
}

/**
 * The original image, over the page.
 *
 * A portal on `document.body` rather than a node inside the transcript: the
 * scroller clips its children, and a preview clipped to the message it came
 * from is not a preview. Escape, the mask, and the close control all dismiss
 * it, and focus returns to whatever opened it.
 */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const opener = useRef<Element | null>(null)
  useEffect(() => {
    opener.current = document.activeElement
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (opener.current instanceof HTMLElement) opener.current.focus()
    }
  }, [onClose])
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className={css.lightbox} role="dialog" aria-modal="true" aria-label={alt}>
      <button type="button" className={css.lightboxMask} aria-label="Close preview" onClick={onClose} />
      <img className={css.lightboxImage} src={src} alt={alt} />
      <button type="button" className={css.lightboxClose} aria-label="Close preview" onClick={onClose}>
        <IconCloseOutline16 />
      </button>
    </div>,
    document.body,
  )
}

/** One generic file, as a card wide enough to read its name. */
function FileCard({
  name,
  bytes,
  mediaType,
  state,
  progress,
  onRemove,
  onRetry,
}: {
  name: string
  bytes: number
  mediaType: string
  state: 'uploading' | 'ready' | 'error'
  progress?: number
  onRemove?: () => void
  onRetry?: () => void
}) {
  return (
    <div className={css.fileCard} data-state={state} title={name}>
      <div className={css.fileGlyph}>
        {state === 'uploading'
          ? <IconLoadingOutline16 className={css.spinner} />
          : <DocumentFileIcon className={css.fileIcon} />}
      </div>
      <div className={css.fileText}>
        <span className={css.fileName}>{name}</span>
        <span className={css.fileMeta}>
          {state === 'error'
            ? 'Upload failed'
            : `${extensionOf(name, mediaType)} · ${fileSizeText(bytes)}`}
        </span>
        {state === 'uploading' && (
          <span className={css.progressTrack}>
            <span
              className={css.progressBar}
              data-indeterminate={progress === undefined || undefined}
              style={progress === undefined ? undefined : { width: `${String(Math.round(progress * 100))}%` }}
            />
          </span>
        )}
      </div>
      {state === 'error' && onRetry !== undefined && (
        <button type="button" className={css.cardAction} aria-label={`Retry ${name}`} onClick={onRetry}>
          <IconRefreshOutline14 />
        </button>
      )}
      {onRemove !== undefined && (
        <button type="button" className={css.remove} aria-label={`Remove ${name}`} onClick={onRemove}>
          <IconCloseFill14 size={12} />
        </button>
      )}
    </div>
  )
}

/**
 * The page-wide drop invitation.
 *
 * Pointer-inert: it only says what a drop would do. The document-level
 * listeners in {@link ComposerAttachments} decide whether the drop is taken.
 */
function DropOverlay({ limits }: { limits: AttachmentsController['limits'] }) {
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className={css.dropOverlay}>
      <div className={css.dropCard}>
        <DocumentFileIcon className={css.dropIcon} />
        <span className={css.dropTitle}>Drop to attach</span>
        <span className={css.dropLimits}>
          Up to {String(limits.maxPerMessage)} files, {fileSizeText(limits.maxImageBytes)} each
        </span>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The composer's draft rail, its drop target, and its preview.
 *
 * Document-level drag listeners rather than a drop zone on the composer: a file
 * dragged onto a chat is meant for the chat, and asking the user to hit a
 * 40-pixel strip with it is a worse answer than accepting it anywhere.
 * @param props - The attachment controller the composer owns.
 * @returns The rail, plus the overlay and lightbox portals when they are open.
 */
export function ComposerAttachments({ attachments }: { attachments: AttachmentsController }) {
  const [preview, setPreview] = useState<DraftAttachment | null>(null)
  const [dragging, setDragging] = useState(false)
  /** Drag enter/leave fire per element, so nesting is counted, not guessed. */
  const depth = useRef(0)
  const { add, canAccept } = attachments

  useEffect(() => {
    const filesIn = (event: DragEvent): DataTransfer | null => {
      const transfer = event.dataTransfer
      return transfer === null || !transfer.types.includes('Files') ? null : transfer
    }
    const reset = (): void => { depth.current = 0; setDragging(false) }
    const onEnter = (event: DragEvent): void => {
      if (filesIn(event) === null) return
      event.preventDefault()
      depth.current += 1
      setDragging(true)
    }
    const onOver = (event: DragEvent): void => {
      const transfer = filesIn(event)
      if (transfer === null) return
      // Without preventDefault the browser navigates to the dropped file.
      event.preventDefault()
      transfer.dropEffect = canAccept ? 'copy' : 'none'
    }
    const onLeave = (event: DragEvent): void => {
      if (filesIn(event) === null) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent): void => {
      const transfer = filesIn(event)
      if (transfer === null) return
      event.preventDefault()
      reset()
      if (canAccept) add([...transfer.files])
    }
    document.addEventListener('dragenter', onEnter)
    document.addEventListener('dragover', onOver)
    document.addEventListener('dragleave', onLeave)
    document.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      document.removeEventListener('dragenter', onEnter)
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('dragleave', onLeave)
      document.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [add, canAccept])

  // A removed draft must not leave its own preview open over the page.
  useEffect(() => {
    if (preview !== null && !attachments.items.some(item => item.id === preview.id)) setPreview(null)
  }, [attachments.items, preview])

  const closePreview = useCallback(() => { setPreview(null) }, [])

  return (
    <>
      {dragging && <DropOverlay limits={attachments.limits} />}
      {attachments.notice !== null && (
        <div className={css.notice} role="status">
          <span>{attachments.notice}</span>
          <button type="button" className={css.noticeClose} aria-label="Dismiss" onClick={attachments.dismissNotice}>
            <IconCloseFill14 size={12} />
          </button>
        </div>
      )}
      {attachments.items.length > 0 && (
        <div className={css.rail}>
          {attachments.items.map((item) => {
            if (item.kind === 'file') {
              const state = item.upload.status === 'ready'
                ? 'ready'
                : item.upload.status === 'error' ? 'error' : 'uploading'
              return (
                <FileCard
                  key={item.id}
                  name={item.file.name}
                  bytes={item.file.size}
                  mediaType={item.file.type}
                  state={state}
                  {...item.upload.status === 'uploading' && item.upload.total > 0
                    ? { progress: item.upload.loaded / item.upload.total }
                    : {}}
                  onRemove={() => { attachments.remove(item.id) }}
                  onRetry={() => { attachments.retry(item.id) }}
                />
              )
            }
            return (
              <div key={item.id} className={css.thumb} data-state={item.upload.status}>
                <button
                  type="button"
                  className={css.thumbButton}
                  title={item.file.name}
                  onClick={() => { setPreview(item) }}
                >
                  <img src={item.previewUrl} alt={item.file.name} />
                </button>
                {item.upload.status === 'uploading' && (
                  <span className={css.thumbVeil}><IconLoadingOutline16 className={css.spinner} /></span>
                )}
                {item.upload.status === 'error' && (
                  <button
                    type="button"
                    className={css.thumbRetry}
                    aria-label={`Retry ${item.file.name}`}
                    onClick={() => { attachments.retry(item.id) }}
                  >
                    <IconRefreshOutline14 />
                  </button>
                )}
                <button
                  type="button"
                  className={css.remove}
                  aria-label={`Remove ${item.file.name}`}
                  onClick={() => { attachments.remove(item.id) }}
                >
                  <IconCloseFill14 size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {preview !== null && preview.previewUrl !== undefined && (
        <Lightbox src={preview.previewUrl} alt={preview.file.name} onClose={closePreview} />
      )}
    </>
  )
}

/**
 * The attachments of one sent message.
 *
 * A lone image is drawn at its own aspect ratio because that is the message —
 * "look at this" with nothing else in it. The moment there is a second
 * attachment they become a uniform row, since the point has become the set
 * rather than any one of them.
 * @param props - The message's stored attachment records.
 * @returns The gallery, and the lightbox while one is open.
 */
export function MessageAttachments({ items }: { items: readonly WireAttachment[] }) {
  const [preview, setPreview] = useState<WireAttachment | null>(null)
  const closePreview = useCallback(() => { setPreview(null) }, [])
  if (items.length === 0) return null
  const lone = items.length === 1 && items[0]?.kind === 'image' ? items[0] : undefined

  return (
    <div className={css.messageGallery} data-lone={lone !== undefined || undefined}>
      {items.map(item => item.kind === 'image'
        ? (
          <button
            key={item.id}
            type="button"
            className={lone === undefined ? css.messageThumb : css.messageLone}
            title={item.name}
            onClick={() => { setPreview(item) }}
          >
            <img
              src={attachmentUrl(item.id)}
              alt={item.name}
              {...item.width === undefined || item.height === undefined
                ? {}
                : { width: item.width, height: item.height }}
            />
          </button>
        )
        : (
          <FileCard
            key={item.id}
            name={item.name}
            bytes={item.bytes}
            mediaType={item.mediaType}
            state="ready"
          />
        ))}
      {preview !== null && (
        <Lightbox src={attachmentUrl(preview.id)} alt={preview.name} onClose={closePreview} />
      )}
    </div>
  )
}
