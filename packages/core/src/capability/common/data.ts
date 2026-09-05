/** Data fields never invoke accessors. Proxy reflection failures are handled by the caller. */
export function objectValue(value: unknown): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a composition data object')
  }
  return value
}

export function ownData(value: object, key: string, required = true): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) {
    if (!required) return undefined
    throw new TypeError('Required composition data field is absent')
  }
  if (!('value' in descriptor)) throw new TypeError('Composition metadata must not use accessors')
  return descriptor.value
}

export function boundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || value.length > maxBytes || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new TypeError('Invalid bounded composition text')
  }
  return value
}

export function arrayData(value: unknown, maxItems: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Expected a composition data array')
  const length = ownData(value, 'length')
  if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maxItems) {
    throw new TypeError('Composition array exceeds its bound')
  }
  const result: unknown[] = []
  for (let index = 0; index < Number(length); index++) result.push(ownData(value, String(index)))
  return Object.freeze(result)
}

export function optionalAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof AbortSignal)) throw new TypeError('Invalid AbortSignal')
  return value
}

export function capturedMethod<Args extends readonly unknown[], Result>(
  receiver: object,
  key: string,
): (...args: Args) => Result {
  const method: unknown = Reflect.get(receiver, key)
  if (typeof method !== 'function') throw new TypeError('Required capability method is absent')
  return (...args: Args): Result => Reflect.apply(method, receiver, args) as Result
}

export function capturedOptionalMethod<Args extends readonly unknown[], Result>(
  receiver: object,
  key: string,
): ((...args: Args) => Result) | undefined {
  const method: unknown = Reflect.get(receiver, key)
  if (method === undefined) return undefined
  if (typeof method !== 'function') throw new TypeError('Optional capability method is invalid')
  return (...args: Args): Result => Reflect.apply(method, receiver, args) as Result
}
