/** Shared fixtures for the Codex usage specs. */
import { vi } from 'vitest'
import type { CodexAuthFile } from '@alvin0/ai-agent-sdk-provider-codex'

export function jwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `e30.${encoded}.signature`
}

export const NOW_SECONDS = Math.floor(Date.now() / 1000)

export function authFile(expiresIn = 3_600): CodexAuthFile {
  return {
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-private-1' } }),
      access_token: jwt({ exp: NOW_SECONDS + expiresIn }),
      refresh_token: 'private-refresh-token',
    },
  }
}

/** The usage body as the live endpoint returns it, personal fields included. */
export const LIVE_BODY = {
  user_id: 'user-private-123',
  account_id: 'acct-private-1',
  email: 'someone@example.com',
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_after_seconds: 18_000,
      reset_at: 1_794_661_029 },
    secondary_window: { used_percent: 11, limit_window_seconds: 604_800, reset_after_seconds: 410_575,
      reset_at: 1_795_053_604 },
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  model_usage: { 'gpt-6-astra': { available: true, available_at: null, credits_would_enable: false } },
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: '0',
    approx_local_messages: [0, 0], approx_cloud_messages: [0, 0] },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reached_type: null,
  promo: null,
  rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 },
}

export function usageFetch(response: () => Response) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response())
}

/** A fetch that never answers and rejects once its signal aborts. */
export function hangingFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
  })
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g')
export const plain = (text: string) => text.replace(ANSI, '')
