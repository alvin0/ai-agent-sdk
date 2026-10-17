import { defineTool } from '../tool/definition.ts'
import { object } from './common.ts'
import type { ManagedProgress } from './managed-progress.ts'

export interface ProgressRequest { interval_ms?: number; targets?: string[]; stop?: boolean }
export function parseProgressRequest(raw: unknown): ProgressRequest {
  const value = object(raw, 'progress_updates')
  if (value.stop !== undefined && typeof value.stop !== 'boolean') throw new TypeError('stop must be boolean')
  if (value.stop === true) return { stop: true }
  if (!Number.isSafeInteger(value.interval_ms) || (value.interval_ms as number) < 1) {
    throw new TypeError('interval_ms must be a positive safe integer')
  }
  validateTargets(value.targets)
  return { interval_ms: value.interval_ms as number,
    ...value.targets === undefined ? {} : { targets: value.targets as string[] } }
}
export function progressTool(progress: ManagedProgress) {
  return defineTool({
    name: 'progress_updates',
    description: 'Send periodic worker status to the user without model calls. Call once when requested; '
      + 'omit targets for all current workers. Calling again replaces; stop:true cancels.',
    parameters: { type: 'object', properties: {
      interval_ms: { type: 'integer', minimum: 1 },
      targets: { type: 'array', items: { type: 'string' }, minItems: 1 },
      stop: { type: 'boolean' },
    }, additionalProperties: false },
    parse: raw => {
      try { return parseProgressRequest(raw) } catch (error) { progress.stop('replaced'); throw error }
    },
    execute: args => progress.configure(args),
  })
}

function validateTargets(targets: unknown): void {
  if (targets === undefined) return
  if (!Array.isArray(targets) || targets.length === 0
    || targets.some(name => typeof name !== 'string' || !name.trim())) {
    throw new TypeError('targets must be a nonempty array of worker names')
  }
}
