/** Provider registration for real human-test runs. */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModelRegistry } from '@ai-agent-sdk/core'
import { anthropicAdapter } from '../src/providers/anthropic/adapter.ts'
import { codexNodeAdapter as codexAdapter } from '@ai-agent-sdk/auth-node/codex'
import { openAiAdapter } from '../src/providers/openai/adapter.ts'
import {
  combineProviderRequestLoggers,
  createDailyJsonlRequestLogger,
} from '../src/providers/request-logger.ts'
import type { HumanCliConfig } from './config.ts'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
    registry.registerAdapter(['openai'], openAiAdapter(logging))
  } else {
    registry.registerAdapter(['anthropic'], anthropicAdapter(logging))
  }
  return registry
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}
