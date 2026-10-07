import { COPILOT_ERROR_CODES } from './common/error-codes.ts'
import type { CopilotProviderOptions, CopilotLegacyProviderOptions } from './adapter-types.ts'
import type { CopilotSecrets } from './adapter-auth.ts'

/**
 * The fetch the provider dispatches through: identical to the injected one,
 * except that an error body is redacted — and, for the one case the endpoint is
 * known to be unhelpful about, explained — before anything retains it.
 *
 * Why here and not in an error mapper: `provider-http` puts the raw error body
 * into the failure's `cause`, and by the time a mapper sees it the text is
 * already retained. Redacting at the transport is the only point that runs BEFORE
 * that, and an endpoint echoing the `Authorization` header back in an error body
 * is something that has actually happened (Requirement 13.7).
 *
 * What is deliberately NOT touched:
 *
 * - **Successful responses.** The body is a live SSE stream and must reach the
 *   pipeline unread and unwrapped.
 * - **Redirects, in every shape.** Rebuilding a `Response` loses `type`,
 *   `redirected` and `url` — the three signals the transport's redirect guard
 *   reads — so anything that is not a 4xx/5xx passes through untouched and the
 *   guard still sees the original (Requirement 7.8).
 * @param options - read for the injected fetch and the error-body bound.
 * @param secrets - the live token values to redact.
 * @returns a fetch implementation to hand to the runtime provider.
 */
export function copilotProviderFetch(
  options: CopilotProviderOptions | CopilotLegacyProviderOptions,
  secrets: CopilotSecrets,
): typeof globalThis.fetch {
  const inner = options.fetch ?? globalThis.fetch
  const maxBytes = options.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES
  return async (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    const response = await inner(...args)
    if (response.status < 400 || response.type === 'opaqueredirect' || response.redirected) {
      return response
    }
    let raw: string
    try {
      raw = await readErrorBody(response, maxBytes)
    } catch {
      // A body that could not be read must not replace the status, which is the
      // more reliable signal anyway.
      return response
    }
    const redacted = secrets.redact(raw)
    const body = isMissingEditorHeaderFailure(response.status, redacted)
      ? editorHeaderDiagnostic(redacted)
      : redacted
    const headers = new Headers(response.headers)
    // The length changed, and a stale content-length would fail the bounded read
    // that comes next.
    headers.delete('content-length')
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

/**
 * Read an error body up to a byte bound, marking a truncation rather than hiding it.
 * @param response - the non-success response.
 * @param maxBytes - the configured bound (Requirement 13.6).
 * @returns the decoded text, truncated with a note when it hit the bound.
 */
export async function readErrorBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return text + decoder.decode()
      if (next.value === undefined) continue
      const remaining = maxBytes - bytes
      if (remaining <= 0 || next.value.byteLength > remaining) {
        const kept = remaining <= 0 ? undefined : next.value.subarray(0, remaining)
        const partial = kept === undefined ? '' : decoder.decode(kept, { stream: true })
        await reader.cancel().catch(() => undefined)
        return `${text}${partial}${decoder.decode()}\n[error body truncated at ${maxBytes} bytes]`
      }
      bytes += next.value.byteLength
      text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Whether a failure looks like the endpoint refusing a request for a missing
 * editor header.
 *
 * Matched BROADLY on purpose. The endpoint's wording is not a contract — it is
 * one sentence that can be rephrased at any time — so this looks for the header
 * names in any plausible spelling, or for the word "editor" beside a complaint
 * about a header. It is also bounded to status 400: a 400 that says nothing about
 * editors keeps `REQUEST_INVALID` from the shared mapping rather than being
 * relabelled into a Copilot-specific failure it is not (Requirement 2.5).
 * @param status - the response status.
 * @param detail - the provider's error text, joined by the shared parser.
 * @returns true when the missing-header diagnosis is warranted.
 */
export function isMissingEditorHeaderFailure(status: number, detail: string): boolean {
  if (status !== 400) return false
  if (/editor[\s_-]*(?:plugin[\s_-]*)?version/i.test(detail)) return true
  return /\beditor\b/i.test(detail)
    && /(missing|required|absent|invalid|unsupported|unrecogni[sz]ed|header)/i.test(detail)
}

/**
 * Wrap the endpoint's 400 in a body that names both headers and how to set them.
 *
 * The endpoint's own text is kept beside it rather than replaced: it is the
 * evidence, and the shared classifier reads it too.
 * @param endpointText - the endpoint's error body, already redacted.
 * @returns a JSON error body carrying the SDK-authored diagnosis.
 */
export function editorHeaderDiagnostic(endpointText: string): string {
  return JSON.stringify({
    error: {
      code: COPILOT_ERROR_CODES.EDITOR_HEADERS_MISSING,
      message: 'the Copilot endpoint rejected this request for a missing or unaccepted editor '
        + 'header. Both `Editor-Version` and `Editor-Plugin-Version` are mandatory; configure '
        + 'them with the `editorHeaders` option (`editorVersion`, `editorPluginVersion`), whose '
        + 'defaults are the exported COPILOT_EDITOR_VERSION and '
        + `COPILOT_EDITOR_PLUGIN_VERSION constants. The endpoint said: ${endpointText}`,
    },
  })
}

/** Bytes read from a non-success response when the caller configures no bound. */
export const DEFAULT_MAX_ERROR_BODY_BYTES = 1024 * 1024
