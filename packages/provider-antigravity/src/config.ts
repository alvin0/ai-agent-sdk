/** Service endpoints and protocol metadata. OAuth clients are supplied by the host. */
export const ANTIGRAVITY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const ANTIGRAVITY_BROWSER_CALLBACK_PORT = 51121
export const ANTIGRAVITY_BROWSER_CALLBACK_PATH = '/oauth-callback'
export const ANTIGRAVITY_USER_AGENT = 'antigravity/hub/2.24.0 (aidev_client)'
export const ANTIGRAVITY_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
])
