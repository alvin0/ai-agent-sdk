import {
  antigravityAdapter, antigravityPlugin, type AntigravityCredentialStore,
  type AntigravityPluginOptions, type AntigravityProviderOptions,
} from '@alvin0/ai-agent-sdk-provider-antigravity'
import { antigravityAccountAuthPath, fileAntigravityCredentialStore } from './antigravity-store.ts'
import { withDefaultNodeFetch } from './http2/default.ts'
import { withAntigravityOAuthEnvironment } from './antigravity-oauth.ts'

export interface AntigravityNodeProviderOptions extends Omit<AntigravityPluginOptions, 'authStore'> {
  readonly authStore?: AntigravityCredentialStore
  readonly account?: string
}

function nodeOptions(options: AntigravityNodeProviderOptions): AntigravityProviderOptions {
  return { ...withDefaultNodeFetch(withAntigravityOAuthEnvironment(options)),
    authStore: options.authStore ?? fileAntigravityCredentialStore(
    options.account === undefined ? undefined : antigravityAccountAuthPath(options.account)) }
}

export function antigravityNodeProviderPlugin(options: AntigravityNodeProviderOptions = {}) {
  return antigravityPlugin(nodeOptions(options))
}

export function antigravityNodeAdapter(options: AntigravityNodeProviderOptions = {}) {
  return antigravityAdapter(nodeOptions(options))
}

export * from '@alvin0/ai-agent-sdk-provider-antigravity'
export * from './antigravity-store.ts'
export { ANTIGRAVITY_CLIENT_ID_ENV, ANTIGRAVITY_CLIENT_SECRET_ENV } from './antigravity-oauth.ts'
export {
  runAntigravityBrowserLogin, type AntigravityBrowserLoginOptions, type AntigravityBrowserLoginProgress,
} from './antigravity-browser.ts'
