import type { ChildProcess } from 'node:child_process'
import type { Acquire, Semaphore } from './reliability.ts'

type PermitMessage = { permit: 'acquire' | 'release' | 'cancel' | 'granted'; id: number }
export function isPermitMessage(value: unknown): value is PermitMessage {
  return value !== null && typeof value === 'object' && 'permit' in value && 'id' in value
}

/** All children share the parent's one semaphore, including retries and worker sessions. */
export function attachPermits(child: ChildProcess, semaphore: Semaphore) {
  const permits = new Map<number, { controller: AbortController; release?: () => void }>()
  const dispose = () => {
    for (const permit of permits.values()) { permit.controller.abort(); permit.release?.() }
    permits.clear()
  }
  child.on('message', (message: unknown) => {
    if (!isPermitMessage(message)) return
    const { id, permit } = message
    if (permit !== 'acquire') {
      const held = permits.get(id)
      held?.controller.abort(); held?.release?.(); permits.delete(id)
      return
    }
    const held: { controller: AbortController; release?: () => void } = { controller: new AbortController() }
    permits.set(id, held)
    semaphore.acquire(held.controller.signal).then(release => {
      if (held.controller.signal.aborted || !child.connected) { release(); return }
      held.release = release
      child.send({ permit: 'granted', id }, error => { if (error) { release(); permits.delete(id) } })
    }).catch(() => { /* cancelled waiter or child exit */ })
  })
  child.once('exit', dispose)
  child.once('disconnect', dispose)
}

export function ipcAcquire(): Acquire {
  let next = 0
  const pending = new Map<number, { accept: (release: () => void) => void; reject: (error: Error) => void }>()
  const send = (message: PermitMessage) => { if (process.connected) process.send?.(message) }
  process.on('message', (message: unknown) => {
    if (!isPermitMessage(message) || message.permit !== 'granted') return
    pending.get(message.id)?.accept(() => send({ permit: 'release', id: message.id }))
  })
  process.once('disconnect', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Benchmark parent disconnected'))
    pending.clear()
  })
  return signal => new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    if (!process.connected) { reject(new Error('Benchmark parent unavailable')); return }
    const id = next++
    const abort = () => {
      pending.delete(id); send({ permit: 'cancel', id }); reject(signal?.reason)
    }
    pending.set(id, { accept: release => {
      pending.delete(id); signal?.removeEventListener('abort', abort)
      if (signal?.aborted) { release(); reject(signal.reason) } else resolve(release)
    }, reject: error => { signal?.removeEventListener('abort', abort); reject(error) } })
    signal?.addEventListener('abort', abort, { once: true })
    send({ permit: 'acquire', id })
  })
}
