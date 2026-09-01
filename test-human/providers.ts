/** Provider registration for real human-test runs. */

import { resolve } from 'node:path'
import { ModelRegistry } from '@ai-agent-sdk/core'
import { anthropicAdapter } from '@ai-agent-sdk/provider-anthropic'
import { codexNodeAdapter as codexAdapter } from '@ai-agent-sdk/auth-node/codex'
import { envCredential } from '@ai-agent-sdk/auth-node/env'
import { openAiAdapter } from '@ai-agent-sdk/provider-openai'
import {
  combineProviderRequestLoggers,
  createDailyJsonlRequestLogger,
} from 'ai-agent-sdk/request-logger'
import type { HumanCliConfig } from './config.ts'

const PROJECT_ROOT = resolve(process.cwd())
const HUMAN_REQUEST_LOG_ROOT = resolve(PROJECT_ROOT, '.providers')

export interface HumanModelRegistryOptions {
  /** Optional per-run copy; every human run is also aggregated under project `.providers`. */
  readonly requestLogRoot?: string
  /** Mirror into project-wide `.providers` when wire logging is explicitly enabled. */
  readonly aggregateRequestLogs?: boolean
}

export function createHumanModelRegistry(
  config: HumanCliConfig,
  options: HumanModelRegistryOptions = {},
): ModelRegistry {
  const registry = new ModelRegistry()
  const reportRoot = options.requestLogRoot === undefined
    ? undefined
    : resolve(options.requestLogRoot)
  const aggregate = options.aggregateRequestLogs === false
    ? []
    : [createDailyJsonlRequestLogger({
      rootDir: HUMAN_REQUEST_LOG_ROOT, content: 'full', allowWireBodies: true,
    })]
  const requestLogger = config.logs ? combineProviderRequestLoggers(
    ...aggregate,
    ...(reportRoot === undefined || samePath(reportRoot, HUMAN_REQUEST_LOG_ROOT)
      ? []
      : [createDailyJsonlRequestLogger({
        rootDir: reportRoot, content: 'full', allowWireBodies: true,
      })]),
  ) : undefined
  const logging = requestLogger === undefined ? {} : { requestLogger }

  if (config.provider === 'codex') {
    registry.registerAdapter(['codex'], codexAdapter(logging))
  } else if (config.provider === 'openai') {
    registry.registerAdapter(['openai'], openAiAdapter({
      ...logging,
      apiKey: envCredential('OPENAI_API_KEY'),
    }))
  } else {
    registry.registerAdapter(['anthropic'], anthropicAdapter({
      ...logging,
      apiKey: envCredential('ANTHROPIC_API_KEY'),
    }))
  }
  return registry
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}
