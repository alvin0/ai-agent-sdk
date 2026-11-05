/** Per-origin HTTP/2 session pool with real stream multiplexing. */
import { connect, type ClientHttp2Session, type SecureClientSessionOptions } from 'node:http2'
import type { TLSSocket } from 'node:tls'

export interface Http2PoolOptions {
  /** Upper bound on concurrent streams per session; the server's own limit applies when lower. */
  readonly maxStreamsPerSession: number
  /** Close a session after this long with no active stream. */
  readonly idleTimeoutMs: number
  readonly connectTimeoutMs: number
  readonly connect?: SecureClientSessionOptions
}

export interface Http2Lease {
  readonly session: ClientHttp2Session
  /** Return the stream slot. Idempotent. */
  release(): void
}

/** `acquire` after `close()`: the transport no longer serves requests. */
export class Http2ClosedError extends Error {
  constructor() {
    super('HTTP/2 fetch has been closed')
    this.name = 'Http2ClosedError'
  }
}

/** The origin negotiated something other than h2; callers should use HTTP/1.1 for it. */
export class Http2UnsupportedError extends Error {
  constructor(origin: string, options?: ErrorOptions) {
    super(`${origin} does not negotiate HTTP/2`, options)
    this.name = 'Http2UnsupportedError'
  }
}

interface PooledSession {
  readonly origin: string
  readonly session: ClientHttp2Session
  /** The server's SETTINGS frame has arrived, so `remoteSettings` is real. */
  settled: boolean
  readonly ready: Promise<void>
  active: number
  idle: ReturnType<typeof setTimeout> | undefined
  open: boolean
}

const NO_APPLICATION_PROTOCOL = 'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL'

/**
 * Picks a session with a free stream slot, so concurrent requests multiplex on one
 * connection up to the server's SETTINGS_MAX_CONCURRENT_STREAMS and only then open
 * another. Idle sessions are unreferenced and closed, so the pool never keeps a
 * process alive on its own.
 */
export class Http2SessionPool {
  private readonly sessions = new Map<string, PooledSession[]>()
  /** Last SETTINGS_MAX_CONCURRENT_STREAMS each origin announced. */
  private readonly limits = new Map<string, number>()
  private closed = false

  constructor(private readonly options: Http2PoolOptions) {}

  /**
   * Lease a stream slot on a connected session. An abort of `signal` while the
   * session is still connecting rejects with its reason at once; the connect
   * itself goes on for other callers sharing the session.
   */
  async acquire(origin: string, signal?: AbortSignal): Promise<Http2Lease> {
    if (this.closed) throw new Http2ClosedError()
    signal?.throwIfAborted()
    const pooled = this.pick(origin) ?? this.open(origin)
    // Reserve the slot before awaiting so concurrent callers see it as taken.
    this.retain(pooled)
    try {
      await (signal === undefined ? pooled.ready : abortable(pooled.ready, signal))
    } catch (error: unknown) {
      this.release(pooled)
      throw error
    }
    let released = false
    return {
      session: pooled.session,
      release: () => {
        if (released) return
        released = true
        this.release(pooled)
      },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const all = [...this.sessions.values()].flat()
    this.sessions.clear()
    await Promise.all(all.map(pooled => closeSession(pooled)))
  }

  private pick(origin: string): PooledSession | undefined {
    return this.sessions.get(origin)?.find(pooled => pooled.open && pooled.active < this.capacity(pooled))
  }

  /**
   * Until a new session receives SETTINGS its `remoteSettings` are protocol
   * defaults (unbounded), so a burst could overcommit it and the extra streams
   * would wait inside the session. Use the limit the origin announced before.
   */
  private capacity(pooled: PooledSession): number {
    const remote = pooled.settled
      ? pooled.session.remoteSettings.maxConcurrentStreams
      : this.limits.get(pooled.origin)
    return Math.min(this.options.maxStreamsPerSession, remote ?? this.options.maxStreamsPerSession)
  }

  private open(origin: string): PooledSession {
    const session = connect(origin, this.options.connect ?? {})
    const pooled: PooledSession = {
      origin, session, settled: false, ready: this.whenConnected(origin, session),
      active: 0, idle: undefined, open: true,
    }
    session.on('remoteSettings', (settings) => {
      pooled.settled = true
      if (settings.maxConcurrentStreams !== undefined) this.limits.set(origin, settings.maxConcurrentStreams)
    })
    // Rejections are delivered to the acquiring caller; never leave one unhandled.
    pooled.ready.catch(() => undefined)
    const drop = () => this.drop(origin, pooled)
    // A GOAWAY lets in-flight streams finish but takes no new ones.
    session.on('goaway', drop)
    session.on('close', drop)
    session.on('error', drop)
    const list = this.sessions.get(origin) ?? []
    list.push(pooled)
    this.sessions.set(origin, list)
    return pooled
  }

  private whenConnected(origin: string, session: ClientHttp2Session): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.destroy(new Error(`HTTP/2 connect to ${origin} timed out`))
      }, this.options.connectTimeoutMs)
      const fail = (error: unknown) => {
        clearTimeout(timer)
        const code = (error as { code?: unknown } | undefined)?.code
        reject(code === NO_APPLICATION_PROTOCOL ? new Http2UnsupportedError(origin, { cause: error }) : error)
      }
      session.once('error', fail)
      session.once('close', () => fail(new Error(`HTTP/2 session to ${origin} closed before connecting`)))
      session.once('connect', (_session, socket) => {
        clearTimeout(timer)
        session.off('error', fail)
        if ((socket as TLSSocket).alpnProtocol !== 'h2') {
          session.destroy()
          reject(new Http2UnsupportedError(origin))
          return
        }
        resolve()
      })
    })
  }

  private retain(pooled: PooledSession): void {
    pooled.active++
    if (pooled.idle !== undefined) clearTimeout(pooled.idle)
    pooled.idle = undefined
    pooled.session.ref()
  }

  private release(pooled: PooledSession): void {
    pooled.active = Math.max(0, pooled.active - 1)
    if (pooled.active > 0 || pooled.session.destroyed) return
    pooled.session.unref()
    if (!pooled.open) {
      void closeSession(pooled)
      return
    }
    pooled.idle = setTimeout(() => {
      pooled.open = false
      void closeSession(pooled)
    }, this.options.idleTimeoutMs)
    pooled.idle.unref()
  }

  private drop(origin: string, pooled: PooledSession): void {
    pooled.open = false
    const list = this.sessions.get(origin)
    if (list === undefined) return
    const remaining = list.filter(candidate => candidate !== pooled)
    if (remaining.length === 0) this.sessions.delete(origin)
    else this.sessions.set(origin, remaining)
  }
}

function abortable(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

function closeSession(pooled: PooledSession): Promise<void> {
  pooled.open = false
  if (pooled.idle !== undefined) clearTimeout(pooled.idle)
  pooled.idle = undefined
  const { session } = pooled
  if (session.closed || session.destroyed) return Promise.resolve()
  // A graceful close waits for the connect to finish, which may never happen.
  if (session.connecting) {
    session.destroy()
    return Promise.resolve()
  }
  return new Promise<void>(resolve => session.close(() => resolve()))
}
