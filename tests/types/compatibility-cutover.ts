import { ModelRegistry } from 'ai-agent-sdk'
import { anthropicAdapter } from 'ai-agent-sdk/anthropic'
import { openAiAdapter } from 'ai-agent-sdk/openai'
import { apiKeyFromEnv as authApiKeyFromEnv } from '@ai-agent-sdk/auth-node/env'
import { apiKeyFromEnv as nodeApiKeyFromEnv } from 'ai-agent-sdk/node'

// @ts-expect-error K0 intentionally removes the Node environment reader from the Universal root.
import { apiKeyFromEnv as removedRootApiKeyFromEnv } from 'ai-agent-sdk'

new ModelRegistry()
anthropicAdapter({ apiKey: 'fixture' })
openAiAdapter({ apiKey: 'fixture' })
authApiKeyFromEnv('ANTHROPIC_API_KEY')
nodeApiKeyFromEnv('OPENAI_API_KEY')
void removedRootApiKeyFromEnv
