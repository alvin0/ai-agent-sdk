import { geminiPlugin } from '@alvin0/ai-agent-sdk-provider-gemini'

export const providerId = 'gemini'
export const expectedCredential = 'packed-gemini-secret'
export const createPlugin = () => geminiPlugin({ apiKey: expectedCredential })
export const frames = [
  { event_type: 'interaction.created', interaction: { status: 'in_progress' } },
  { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
  { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'packed provider completed' } },
  { event_type: 'step.stop', index: 0 },
  { event_type: 'interaction.completed', interaction: { status: 'completed', usage: { total_input_tokens: 10, total_output_tokens: 2, total_tokens: 12 } } },
]
