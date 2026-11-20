import { raceWithSignal } from './http.ts'

const tails = new Map<string, Promise<unknown>>()

/** Serialize token rotation per login grant while allowing each waiter to cancel independently. */
export function withCredentialRefresh<T>(grantKey: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const pending = Promise.resolve(tails.get(grantKey)).catch(() => undefined).then(() => {
    signal.throwIfAborted()
    return work()
  })
  tails.set(grantKey, pending)
  const cleanup = (): void => { if (tails.get(grantKey) === pending) tails.delete(grantKey) }
  void pending.then(cleanup, cleanup)
  return raceWithSignal(pending, signal)
}

/** Bind legacy files to their original grant on first rotation, without storing the old refresh token. */
export async function credentialLoginId(loginId: string | undefined, refreshToken: string): Promise<string> {
  if (loginId !== undefined) return loginId
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
