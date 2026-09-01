/**
 * The non-secret product identity every provider request sends as `User-Agent`.
 *
 * Centralized so adapters cannot drift apart, and defaulted so that omitting the
 * argument cannot silently suppress attribution.
 *
 * @module ai-agent-sdk/core/http/attribution
 */

/**
 * This package's version, mirrored from `package.json`.
 *
 * A literal rather than a runtime manifest read, because the bundle targets
 * neutral platforms where no module loader is guaranteed. Keep it in step with
 * `package.json` on release.
 */
export const SDK_VERSION = '0.0.0'

/**
 * Static PUBLIC application identity sent to providers.
 *
 * Every field is a public product fact, safe on every request. No secrets, local
 * paths, prompt text, or per-user identifiers belong here, and nothing
 * per-request may influence the values.
 */
export interface AppIdentity {
  /** `User-Agent` product token (lowercase, hyphenated). */
  product: string
  /** Product version. */
  version: string
  /** Home URL of the app, used as the `User-Agent` comment. */
  url: string
}

/**
 * This SDK's own identity: the default every adapter sends.
 *
 * An application that needs its own identity passes one to
 * {@link attributionHeaders}; omission falls back here.
 */
export const APP_IDENTITY: AppIdentity = {
  product: 'ai-agent-sdk',
  version: SDK_VERSION,
  url: 'https://github.com/dinh-ai/ai-agent-sdk',
}

/**
 * The standard `User-Agent` value: `product/version (+url)`.
 *
 * The parenthesized `+url` comment is the conventional self-identification form
 * (RFC 9110 §10.1.5 product-plus-comment syntax).
 * @param identity - the identity to render; defaults to {@link APP_IDENTITY}.
 * @returns the ready-to-send header value.
 */
export function userAgent(identity: AppIdentity = APP_IDENTITY): string {
  return `${identity.product}/${identity.version} (+${identity.url})`
}

/**
 * Build the attribution headers an adapter sends on every provider request.
 *
 * Header names are lowercase; HTTP field names are case-insensitive on the wire.
 * @param identity - the identity to send; defaults to {@link APP_IDENTITY}.
 * @returns headers to merge into the provider request.
 */
export function attributionHeaders(identity: AppIdentity = APP_IDENTITY): Record<string, string> {
  return { 'user-agent': userAgent(identity) }
}
