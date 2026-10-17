/** Largest delay a timer honors: the default deadline, meaning none in practice; hosts opt in to less. */
export const A2A_NO_DEADLINE_MS = 2_147_483_647

export function defaultLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${label} must be a positive integer`)
  return resolved
}
