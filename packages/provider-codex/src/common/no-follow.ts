import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'

/** Reject every redirect shape exposed by Web fetch before any second request. */
export async function rejectCodexRedirect(
  response: Response,
  requestedUrl: string,
  operation: 'OAuth' | 'model catalog',
  teardownTimeoutMs: number,
): Promise<void> {
  const redirectStatus = response.status >= 300 && response.status < 400
  const responseUrlChanged = response.url.length > 0 && response.url !== requestedUrl
  if (response.type !== 'opaqueredirect' && response.redirected !== true
    && !redirectStatus && !responseUrlChanged) return
  if (response.body !== null) {
    await waitForSettlement(response.body.cancel().catch(() => undefined), teardownTimeoutMs)
  }
  throw new TypeError(`Codex ${operation} rejected a redirect before following it`)
}
