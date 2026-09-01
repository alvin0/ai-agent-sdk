export interface ConformanceCase {
  name: string
  chunks: Uint8Array[]
  expected: Trace
}

export interface Trace {
  events: Array<{ id?: string; event?: string; data: string }>
  comments: string[]
  ids: string[]
  retries: number[]
  errors: Array<{ type: string; field?: string; value?: string; line?: string }>
}

const encoder = new TextEncoder()

export function bytes(text: string): Uint8Array {
  return encoder.encode(text)
}

export function emptyTrace(overrides: Partial<Trace> = {}): Trace {
  return { events: [], comments: [], ids: [], retries: [], errors: [], ...overrides }
}

export const conformanceCases: ConformanceCase[] = [
  {
    name: 'start-only BOM split at every byte',
    chunks: [Uint8Array.of(0xef), Uint8Array.of(0xbb), Uint8Array.of(0xbf), bytes('data: ok\n\n')],
    expected: emptyTrace({ events: [{ data: 'ok' }] }),
  },
  {
    name: 'CR LF and CRLF boundaries',
    chunks: [bytes('data: a\r'), bytes('\ndata: b\r'), bytes('\rdata: c\n'), bytes('\n')],
    expected: emptyTrace({ events: [{ data: 'a\nb' }, { data: 'c' }] }),
  },
  {
    name: 'split UTF-8 scalar',
    chunks: [bytes('data: '), Uint8Array.of(0xf0, 0x9f), Uint8Array.of(0x92, 0xa9, 0x0a, 0x0a)],
    expected: emptyTrace({ events: [{ data: '💩' }] }),
  },
  {
    name: 'invalid UTF-8 uses replacement',
    chunks: [bytes('data: '), Uint8Array.of(0xe2, 0x28, 0xa1), bytes('\n\n')],
    expected: emptyTrace({ events: [{ data: '�(�' }] }),
  },
  {
    name: 'comments are activity and fields assemble',
    chunks: [bytes(': heartbeat\nevent: delta\nid: 42\ndata: one\ndata:two\nretry: 1500\n\n')],
    expected: emptyTrace({
      comments: ['heartbeat'],
      ids: ['42'],
      retries: [1500],
      events: [{ id: '42', event: 'delta', data: 'one\ntwo' }],
    }),
  },
  {
    name: 'NUL id invalid retry unknown fields and empty values',
    chunks: [bytes('id: good\nid: bad\0id\nretry: 12x\nunknown: value\nevent:\ndata\n\n')],
    expected: emptyTrace({
      ids: ['good'],
      events: [{ id: 'good', data: '' }],
      errors: [
        { type: 'invalid-retry', value: '12x', line: 'retry: 12x' },
        { type: 'unknown-field', field: 'unknown', value: 'value', line: 'unknown: value' },
      ],
    }),
  },
  {
    name: 'ASCII digits only retry',
    chunks: [bytes('retry: 00042\nretry: ١٢\n\n')],
    expected: emptyTrace({
      retries: [42],
      errors: [{ type: 'invalid-retry', value: '١٢', line: 'retry: ١٢' }],
    }),
  },
  {
    name: 'unknown case-sensitive field and comment without space',
    chunks: [bytes(':tight\nData: ignored\ndata: kept\n\n')],
    expected: emptyTrace({
      comments: ['tight'],
      events: [{ data: 'kept' }],
      errors: [{ type: 'unknown-field', field: 'Data', value: 'ignored', line: 'Data: ignored' }],
    }),
  },
  {
    name: 'EOF truncation discards pending event',
    chunks: [bytes('data: never dispatched\n')],
    expected: emptyTrace(),
  },
  {
    name: 'BOM away from start is data',
    chunks: [bytes('data: first\n\ndata: \uFEFFsecond\n\n')],
    expected: emptyTrace({ events: [{ data: 'first' }, { data: '\uFEFFsecond' }] }),
  },
]

export const differentialCorpus: Uint8Array[] = [
  ...conformanceCases.map((entry) => concat(entry.chunks)),
  bytes('data: [DONE]\n\n'),
  bytes('event: message_start\ndata: {"type":"message_start"}\n\n'),
  bytes('id\n\ndata:\n\nretry: 0\n\n'),
  bytes('data: first\r\ndata: second\r\n\r\n'),
  bytes(':keepalive\rdata: x\r\r'),
]

export function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}
