import { createAgentRuntime } from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

/** Compile-only proof that two accounts from one provider family can own distinct routes. */
export async function createMultiAccountRuntime(teamAKey: string, teamBKey: string) {
  const runtime = await createAgentRuntime({
    providers: [
      openAiPlugin({
        id: 'openai-team-a',
        defaultModel: 'gpt-5.4',
        apiKey: teamAKey,
        organization: 'team-a',
        project: 'agent-sdk',
        store: false,
        models: [{ id: 'gpt-5.4', inputModalities: ['text'] }],
        maxSseEvents: 100_000,
        retryPolicy: { mode: 'normal', maxRetries: 2 },
      }),
      openAiPlugin({
        id: 'openai-team-b',
        defaultModel: 'gpt-5.4',
        apiKey: teamBKey,
      }),
    ],
    defaultProvider: 'openai-team-a',
  })

  const providerRows = runtime.providers()
  const teamA = providerRows.find(provider =>
    provider.route === 'openai-team-a'
    && provider.pluginId === 'openai-team-a'
    && provider.family === 'openai')
  const teamB = providerRows.find(provider =>
    provider.route === 'openai-team-b'
    && provider.pluginId === 'openai-team-b'
    && provider.family === 'openai')
  if (teamA === undefined || teamB === undefined) {
    throw new Error('provider topology lost account-to-route identity')
  }

  await Promise.all([
    runtime.modelCatalog(teamA.route),
    runtime.modelCatalog(teamB.route),
  ])

  runtime.agent({
    id: 'team-a-assistant',
    model: { provider: 'openai-team-a', id: 'gpt-5.4' },
    instructions: 'Use the explicitly selected account route.',
  })

  // Different agents may override the provider default with independent model IDs.
  const specialist = runtime.agent({
    id: 'specialist',
    model: { provider: 'openai-team-b', id: 'specialist-model' },
    instructions: 'Use the model selected for this agent.',
  })
  const inherited = runtime.agent({ id: 'inherited', instructions: 'Use the configured runtime route default.' })
  const routeDefault = runtime.agent({
    id: 'route-default', model: { provider: 'openai-team-b' }, instructions: 'Use this route default.',
  })
  const resolvedTargets: readonly { readonly provider: string; readonly id: string }[] = [
    specialist.model, inherited.model, routeDefault.model,
  ]
  void resolvedTargets

  return runtime
}
