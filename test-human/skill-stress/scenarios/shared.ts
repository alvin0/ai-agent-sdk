import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSession } from '@alvin0/ai-agent-sdk-core/agent'
import type { AgentRunOutcome } from '@alvin0/ai-agent-sdk-core/agent'
import type { StressObserver } from '../observer.ts'

export async function consume(
  session: AgentSession,
  input: string,
  observer: StressObserver,
  signal?: AbortSignal,
): Promise<AgentRunOutcome | undefined> {
  let outcome: AgentRunOutcome | undefined
  for await (const event of session.stream(input, signal === undefined ? {} : { signal })) {
    observer.recordEvent(event)
    if (event.type === 'agent-end') outcome = event.outcome
  }
  return outcome
}

export async function writeMetadataOnlyFixture(root: string): Promise<void> {
  const directory = join(root, 'checkpoint-routing')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---', 'name: checkpoint-routing',
    'description: Use when a long task must continue safely after context compaction.',
    '---', '# Checkpoint routing', 'Preserve the original objective and verified evidence.', '',
  ].join('\n'), 'utf8')
}

export function orderedSubsequence(
  values: readonly string[],
  expected: readonly string[],
): boolean {
  let cursor = 0
  for (const value of values) if (value === expected[cursor]) cursor++
  return cursor === expected.length
}

export async function optionalRead(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') }
  catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') return undefined
    throw error
  }
}
