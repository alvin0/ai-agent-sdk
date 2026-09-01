/** Concerns shared by every adapter that speaks HTTP to a provider. */

export {
  assertUsableApiKey,
  normalizeApiKey,
  type ApiKeyCheck,
  type ApiKeyRejection,
} from './api-key.ts'
export {
  APP_IDENTITY,
  SDK_VERSION,
  attributionHeaders,
  userAgent,
  type AppIdentity,
} from './attribution.ts'
