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
  /**
   * Stop keeping the process alive for this stream while it waits on its reader
   * (a response body nobody is reading). The slot stays taken. Idempotent.
   */
  unhold(): void
  /** Keep the process alive for this stream again (its reader is waiting for data). Idempotent. */
  hold(): void
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
  /** Leased stream slots. */
  active: number
  /** Leases that keep the process alive; the session is ref'd while this is above zero. */
  holds: number
  idle: ReturnType<typeof setTimeout> | undefined
  open: boolean
  closing: Promise<void> | undefined
  closingKeepsAlive: boolean
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
  private closing: Promise<void> | undefined

  constructor(private readonly options: Http2PoolOptions) {}

  /**
   * Lease a stream slot on a connected session. An abort of `signal` while the
   * session is still connecting rejects with its reason at once; the connect
   * itself goes on for other callers sharing the session.
   */
  async acquire(origin: string, signal?: AbortSignal): Promise<Http2Lease> {
    let pooled: PooledSession
    while (true) {
      if (this.closed) throw new Http2ClosedError()
      signal?.throwIfAborted()
      pooled = this.pick(origin) ?? this.open(origin)
      // Reserve before awaiting so callers share a connecting session. SETTINGS
      // can lower its capacity, so excess reservations move to another session.
      this.retain(pooled)
      try {
        await (signal === undefined ? pooled.ready : abortable(pooled.ready, signal))
        signal?.throwIfAborted()
      } catch (error: unknown) {
        this.unhold(pooled)
        this.releaseSlot(pooled)
        throw error
      }
      if (pooled.open && pooled.active <= this.capacity(pooled)) break
      this.unhold(pooled)
      this.releaseSlot(pooled)
    }
    let released = false
    let held = true
    return {
      session: pooled.session,
      unhold: () => {
        if (released || !held) return
        held = false
        this.unhold(pooled)
      },
      hold: () => {
        if (released || held) return
        held = true
        this.hold(pooled)
      },
      release: () => {
        if (released) return
        released = true
        if (held) this.unhold(pooled)
        held = false
        this.releaseSlot(pooled)
      },
    }
  }

  async close(): Promise<void> {
    if (this.closing !== undefined) return await this.closing
    this.closed = true
    const all = [...this.sessions.values()].flat()
    this.sessions.clear()
    this.limits.clear()
    this.closing = Promise.all(all.map(pooled => closeSession(pooled, true))).then(() => undefined)
    await this.closing
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
    const maximum = Math.max(1, Math.floor(this.options.maxStreamsPerSession))
    const remote = pooled.settled
      ? pooled.session.remoteSettings.maxConcurrentStreams
      : this.limits.get(pooled.origin)
    return Math.min(maximum, remote ?? maximum)
  }

  private open(origin: string): PooledSession {
    const session = connect(origin, this.options.connect ?? {})
    const pooled: PooledSession = {
      origin, session, settled: false, ready: this.whenConnected(origin, session),
      active: 0, holds: 0, idle: undefined, open: true,
      closing: undefined, closingKeepsAlive: false,
    }
    session.on('remoteSettings', (settings) => {
      pooled.settled = true
      if (pooled.open && !this.closed && settings.maxConcurrentStreams !== undefined) {
        this.limits.set(origin, settings.maxConcurrentStreams)
      }
    })
    // Rejections are delivered to the acquiring caller; never leave one unhandled.
    pooled.ready.catch(() => undefined)
    // A GOAWAY lets in-flight streams finish but takes no new ones.
    session.on('goaway', () => this.drop(origin, pooled, false))
    session.on('close', () => this.drop(origin, pooled, true))
    session.on('error', () => this.drop(origin, pooled, false))
    const list = this.sessions.get(origin) ?? []
    list.push(pooled)
    this.sessions.set(origin, list)
    return pooled
  }

  private whenConnected(origin: string, session: ClientHttp2Session): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let connected = false
      let settingsReceived = false
      const timer = setTimeout(() => {
        session.destroy(new Error(`HTTP/2 connect to ${origin} timed out`))
      }, this.options.connectTimeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        session.off('error', fail)
        session.off('close', closed)
        session.off('connect', connectedSession)
        session.off('remoteSettings', settings)
      }
      const ready = () => {
        if (!connected || !settingsReceived) return
        cleanup()
        resolve()
      }
      const fail = (error: unknown) => {
        cleanup()
        const code = (error as { code?: unknown } | undefined)?.code
        reject(code === NO_APPLICATION_PROTOCOL ? new Http2UnsupportedError(origin, { cause: error }) : error)
      }
      const closed = () => fail(new Error(`HTTP/2 session to ${origin} closed before connecting`))
      const settings = () => {
        settingsReceived = (session.remoteSettings.maxConcurrentStreams ?? 1) > 0
        ready()
      }
      const connectedSession = (_session: ClientHttp2Session, socket: unknown) => {
        if ((socket as TLSSocket).alpnProtocol !== 'h2') {
          fail(new Http2UnsupportedError(origin))
          session.destroy()
          return
        }
        connected = true
        ready()
      }
      session.once('error', fail)
      session.once('close', closed)
      session.once('connect', connectedSession)
      session.on('remoteSettings', settings)
    })
  }

  private retain(pooled: PooledSession): void {
    pooled.active++
    if (pooled.idle !== undefined) clearTimeout(pooled.idle)
    pooled.idle = undefined
    this.hold(pooled)
  }

  private hold(pooled: PooledSession): void {
    if (pooled.holds++ === 0 && !pooled.session.destroyed) pooled.session.ref()
  }

  private unhold(pooled: PooledSession): void {
    pooled.holds = Math.max(0, pooled.holds - 1)
    if (pooled.holds === 0 && !pooled.closingKeepsAlive && !pooled.session.destroyed) pooled.session.unref()
  }

  private releaseSlot(pooled: PooledSession): void {
    pooled.active = Math.max(0, pooled.active - 1)
    if (pooled.active > 0 || pooled.session.destroyed) return
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

  private drop(origin: string, pooled: PooledSession, closed: boolean): void {
    pooled.open = false
    if (pooled.idle !== undefined) clearTimeout(pooled.idle)
    pooled.idle = undefined
    if (pooled.active === 0) void closeSession(pooled)
    // A draining GOAWAY session remains owned until it actually closes, so an
    // explicit pool close can still await its active streams.
    if (!closed && !pooled.session.destroyed) return
    const list = this.sessions.get(origin)
    if (list === undefined) return
    const remaining = list.filter(candidate => candidate !== pooled)
    if (remaining.length === 0) {
      this.sessions.delete(origin)
      this.limits.delete(origin)
    }
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

function closeSession(pooled: PooledSession, keepAlive = false): Promise<void> {
  pooled.open = false
  if (pooled.idle !== undefined) clearTimeout(pooled.idle)
  pooled.idle = undefined
  const { session } = pooled
  if (session.destroyed) return Promise.resolve()
  if (keepAlive) {
    pooled.closingKeepsAlive = true
    session.ref()
  }
  if (pooled.closing !== undefined) return pooled.closing
  // A graceful close waits for the connect to finish, which may never happen.
  if (session.connecting) {
    session.destroy()
    return Promise.resolve()
  }
  let complete!: () => void
  pooled.closing = new Promise<void>(resolve => { complete = resolve })
  session.close(() => {
    pooled.closingKeepsAlive = false
    if (!session.destroyed) session.unref()
    complete()
  })
  return pooled.closing
}
