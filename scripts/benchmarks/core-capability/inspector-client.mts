/** Minimal local-only RFC 6455 client for workerd's DevTools inspector. */

import { createHash, randomBytes } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'

export interface InspectorHeapUsage {
  readonly usedSize: number
  readonly totalSize: number
  readonly embedderHeapUsedSize: number
  readonly backingStorageSize: number
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

export class InspectorClient {
  private readonly socket: Socket
  private readonly pending = new Map<number, PendingCommand>()
  private incoming = Buffer.alloc(0)
  private fragmented: Buffer[] = []
  private nextId = 1
  private closed = false

  private constructor(socket: Socket) {
    this.socket = socket
    socket.on('data', chunk => this.feed(Buffer.from(chunk)))
    socket.on('error', error => this.fail(error))
    socket.on('close', () => this.fail(new Error('inspector connection closed')))
  }

  static async connect(input: string): Promise<InspectorClient> {
    const url = new URL(input)
    if (url.protocol !== 'ws:') throw new TypeError('inspector URL must use ws:')
    const port = Number(url.port || 80)
    const socket = createConnection({ host: url.hostname, port })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const key = randomBytes(16).toString('base64')
    const expectedAccept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    const path = `${url.pathname || '/'}${url.search}`
    socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `Origin: http://${url.host}`,
      '',
      '',
    ].join('\r\n'))
    const handshake = await readHandshake(socket)
    if (!/^HTTP\/1\.1 101\b/u.test(handshake.headers)) {
      socket.destroy()
      throw new Error(`inspector WebSocket upgrade failed: ${handshake.headers.split('\r\n')[0]}`)
    }
    const accept = /^Sec-WebSocket-Accept:\s*(.+)$/imu.exec(handshake.headers)?.[1]?.trim()
    if (accept !== expectedAccept) {
      socket.destroy()
      throw new Error('inspector WebSocket returned an invalid accept key')
    }
    const client = new InspectorClient(socket)
    if (handshake.remainder.length > 0) client.feed(handshake.remainder)
    return client
  }

  async command<T>(method: string, params?: Readonly<Record<string, unknown>>): Promise<T> {
    if (this.closed) throw new Error('inspector connection is closed')
    const id = this.nextId++
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`inspector command timed out: ${method}`))
      }, 5_000)
      this.pending.set(id, { resolve, reject, timeout })
    })
    this.writeFrame(0x1, Buffer.from(JSON.stringify({
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })))
    return await response as T
  }

  async heapUsage(): Promise<InspectorHeapUsage> {
    return await this.command<InspectorHeapUsage>('Runtime.getHeapUsage')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.writeFrame(0x8, Buffer.alloc(0)) } catch { /* socket may already be gone */ }
    this.socket.end()
    this.fail(new Error('inspector connection closed'))
  }

  private feed(chunk: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, chunk])
    while (true) {
      const frame = parseFrame(this.incoming)
      if (frame === undefined) return
      this.incoming = this.incoming.subarray(frame.bytes)
      if (frame.opcode === 0x8) {
        this.closed = true
        this.socket.end()
        this.fail(new Error('inspector closed the WebSocket'))
        return
      }
      if (frame.opcode === 0x9) {
        this.writeFrame(0xA, frame.payload)
        continue
      }
      if (frame.opcode === 0x1) this.fragmented = [frame.payload]
      else if (frame.opcode === 0x0) this.fragmented.push(frame.payload)
      else continue
      if (!frame.fin) continue
      const payload = Buffer.concat(this.fragmented).toString('utf8')
      this.fragmented = []
      this.receive(payload)
    }
  }

  private receive(payload: string): void {
    let message: { id?: unknown; result?: unknown; error?: unknown }
    try { message = JSON.parse(payload) as typeof message } catch { return }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    clearTimeout(pending.timeout)
    if (message.error !== undefined) pending.reject(new Error(`inspector command failed: ${JSON.stringify(message.error)}`))
    else pending.resolve(message.result)
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4)
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    const masked = Buffer.alloc(payload.length)
    for (let index = 0; index < payload.length; index++) {
      masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
    }
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  private fail(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
  }
}

async function readHandshake(socket: Socket): Promise<{
  readonly headers: string
  readonly remainder: Buffer
}> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timeout = setTimeout(() => finish(new Error('inspector WebSocket handshake timed out')), 5_000)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      cleanup()
      resolve({
        headers: buffer.subarray(0, end).toString('utf8'),
        remainder: buffer.subarray(end + 4),
      })
    }
    const finish = (error: Error): void => { cleanup(); reject(error) }
    const cleanup = (): void => {
      clearTimeout(timeout)
      socket.off('data', onData)
      socket.off('error', finish)
      socket.off('close', onClose)
    }
    const onClose = (): void => finish(new Error('inspector closed during WebSocket handshake'))
    socket.on('data', onData)
    socket.once('error', finish)
    socket.once('close', onClose)
  })
}

function parseFrame(input: Buffer): {
  readonly fin: boolean
  readonly opcode: number
  readonly payload: Buffer
  readonly bytes: number
} | undefined {
  if (input.length < 2) return undefined
  const first = input[0] ?? 0
  const second = input[1] ?? 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (input.length < 4) return undefined
    length = input.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (input.length < 10) return undefined
    const value = input.readBigUInt64BE(2)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('inspector frame is too large')
    length = Number(value)
    offset = 10
  }
  const masked = (second & 0x80) !== 0
  const maskBytes = masked ? 4 : 0
  if (input.length < offset + maskBytes + length) return undefined
  const mask = masked ? input.subarray(offset, offset + 4) : undefined
  offset += maskBytes
  const source = input.subarray(offset, offset + length)
  const payload = masked ? Buffer.alloc(length) : Buffer.from(source)
  if (masked && mask !== undefined) {
    for (let index = 0; index < length; index++) {
      payload[index] = (source[index] ?? 0) ^ (mask[index % 4] ?? 0)
    }
  }
  return {
    fin: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    payload,
    bytes: offset + length,
  }
}
