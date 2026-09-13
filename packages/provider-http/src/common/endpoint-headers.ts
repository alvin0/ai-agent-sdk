import { mergeHeaderLayers } from './header-layers.ts'

/** Capture custom endpoint headers per operation, rejecting reserved names and collisions. */
export function endpointHeaders(
  headers: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>) | undefined,
  defaults: Readonly<Record<string, string>> = {},
): () => Readonly<Record<string, string>> {
  const fixedDefaults = mergeHeaderLayers([{ layer: 'endpoint', headers: defaults }]).headers
  const capture = (value: Readonly<Record<string, string>>) => mergeHeaderLayers([
    { layer: 'endpoint', headers: fixedDefaults },
    { layer: 'endpoint', headers: value },
  ]).headers
  if (typeof headers === 'function') return () => capture(headers())
  const fixed = capture(headers ?? {})
  return () => fixed
}
