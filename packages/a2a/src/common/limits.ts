export function defaultLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${label} must be a positive integer`)
  return resolved
}
