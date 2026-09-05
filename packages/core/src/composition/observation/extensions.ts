import type { ContentRedactor, ObservationProcessor } from '../../observation/telemetry-types.ts'
import type { ObservationSpan, OpenObservationSpanInput } from '../../observation/index.ts'
import { arrayData, capturedMethod, objectValue, ownData } from '../common/data.ts'

const COMPONENT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/
const MAX_COMPONENTS = 64

function components(value: unknown, kind: 'processor' | 'redactor'): readonly { source: object; id: string }[] {
  if (value === undefined) return Object.freeze([])
  const entries = arrayData(value, MAX_COMPONENTS).map(item => {
    const source = objectValue(item)
    const id = ownData(source, 'id')
    if (typeof id !== 'string' || !COMPONENT_ID.test(id)) throw new TypeError(`Invalid observation ${kind} identity`)
    return { source, id }
  })
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
    throw new TypeError(`Duplicate observation ${kind} identity`)
  }
  return entries
}

export function captureProcessors(value: unknown): readonly ObservationProcessor[] {
  const entries = components(value, 'processor')
  try { return Object.freeze(entries.map(({ source, id }) => Object.freeze({
    id,
    transform: capturedMethod<Parameters<ObservationProcessor['transform']>, ReturnType<ObservationProcessor['transform']>>(
      source,
      'transform',
    ),
  }))) } catch { throw new TypeError('Invalid observation processor method') }
}

export function captureRedactors(value: unknown): readonly ContentRedactor[] {
  const entries = components(value, 'redactor')
  try { return Object.freeze(entries.map(({ source, id }) => Object.freeze({
    id,
    redact: capturedMethod<Parameters<ContentRedactor['redact']>, ReturnType<ContentRedactor['redact']>>(
      source,
      'redact',
    ),
  }))) } catch { throw new TypeError('Invalid observation redactor method') }
}

export function captureOpenSpan(
  receiver: object,
  value: unknown,
): ((input: OpenObservationSpanInput) => ObservationSpan) | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'function') throw new TypeError('Invalid observation span backend')
  return (input): ObservationSpan => Reflect.apply(value, receiver, [input]) as ObservationSpan
}
