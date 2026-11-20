/** Bounded metadata lookup for diagnostics across package copies and wrapped errors. */
export function diagnosticErrorCode(value: unknown): string | undefined {
  const seen = new Set<unknown>()
  let current = value
  for (let depth = 0; depth < 16; depth++) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')
      || seen.has(current)) return undefined
    seen.add(current)
    const code = ownErrorField(current, 'code')
    if (typeof code === 'string' && code !== 'AGENT_RUN_FAILED'
      && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) return code
    current = ownErrorField(current, 'cause')
  }
  return undefined
}

/** Accessors and proxy failures never replace the error being diagnosed. */
export function ownErrorField(value: object, key: 'code' | 'cause'): unknown {
  try {
    const field = Object.getOwnPropertyDescriptor(value, key)
    return field !== undefined && 'value' in field ? field.value : undefined
  } catch { return undefined }
}
