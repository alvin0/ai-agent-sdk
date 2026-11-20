/** Project policy for live examples. SDK consumers configure their own models. */
export function decisionSampleModel(requested?: string): string {
  const model = requested ?? 'gpt-6-luna'
  const permitted = /^gpt-(?:6-(?:luna|sol|astra)(?:-|$)|6\.[1-9]\d*(?:[.-]|$)|(?:[7-9]|[1-9]\d+)(?:[.-]|$))/u
  if (!permitted.test(model)) throw new Error('Use gpt-6-luna or a newer OpenAI generation model')
  return model
}
