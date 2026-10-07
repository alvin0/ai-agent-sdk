import type { SdkLogger } from '@alvin0/ai-agent-sdk-core'
import { a2aIntegrationChildLogger, beginA2AIntegrationOperation } from '../common/integration-operation.ts'

export function executionOperations(logger: SdkLogger | undefined) {
  const requestLogger = a2aIntegrationChildLogger(logger, 'a2a-server-request')
  const requestOperation = beginA2AIntegrationOperation(requestLogger, 'a2a-server', 'request')
  const requestAttempt = requestOperation.attempt(1)
  const executeOperation = beginA2AIntegrationOperation(requestLogger, 'a2a-server', 'execute')
  const executeAttempt = executeOperation.attempt(1)
  return {
    success() {
    requestAttempt.success(); requestOperation.success(); executeAttempt.success(); executeOperation.success()
  },
    abort() { requestAttempt.abort(); requestOperation.abort(); executeAttempt.abort(); executeOperation.abort() },
    fail(code: string) {
      requestAttempt.fail(code); requestOperation.fail(code); executeAttempt.fail(code); executeOperation.fail(code)
    },
  }
}
