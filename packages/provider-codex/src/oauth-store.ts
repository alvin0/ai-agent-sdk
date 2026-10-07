import type { CredentialOperationOptions, SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import {
  type CodexAuthFile,
} from './auth.ts'
import { type CapturedCodexStore } from './common/store-capture.ts'
import type { CodexStoreSnapshot } from './oauth-types.ts'
import { raceAbort } from './oauth-http.ts'

export const NEVER_ABORTED_SIGNAL = new AbortController().signal

export const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
})

export function credentialOperation(signal: AbortSignal | undefined): CredentialOperationOptions {
  return { signal: signal ?? NEVER_ABORTED_SIGNAL, logger: NULL_LOGGER }
}

export async function readStore(
  captured: CapturedCodexStore,
  operation: CredentialOperationOptions,
): Promise<CodexStoreSnapshot> {
  if (captured.kind === 'versioned') {
    operation.signal.throwIfAborted()
    const record = await raceAbort(captured.store.read(operation), operation.signal)
    return record === undefined
      ? { file: undefined, revision: null }
      : { file: record.value, revision: record.revision }
  }
  operation.signal.throwIfAborted()
  return { file: await raceAbort(captured.store.read(), operation.signal), revision: null }
}

export async function commitStore(
  captured: CapturedCodexStore,
  file: CodexAuthFile,
  expectedRevision: string | null,
  operation: CredentialOperationOptions,
): Promise<void> {
  if (captured.kind === 'versioned') {
    await captured.store.commit({ value: file, expectedRevision }, operation)
    return
  }
  await captured.store.write(file)
}

export function storeLabel(captured: CapturedCodexStore): string {
  return captured.label
}

export function isRevisionConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor !== undefined && 'value' in descriptor
    && descriptor.value === 'CODEX_CREDENTIAL_REVISION_CONFLICT'
}
