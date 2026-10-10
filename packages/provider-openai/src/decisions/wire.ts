import type { DecisionDescription, DecisionInput, DecisionQuestion } from '@alvin0/ai-agent-sdk-decision-adapter'

/** Structured SDK evidence stays text; arbitrary JSON is never interpreted as chat messages. */
export function decisionText(value: DecisionDescription): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}
export function decisionWire(input: DecisionInput, model: string, safetyIdentifier?: string): string {
  return JSON.stringify({
    model, input: decisionText(input.state),
    questions: Object.entries(input.questions).map(([name, question]) => wireQuestion(name, question)),
    ...(safetyIdentifier === undefined ? {} : { safety_identifier: safetyIdentifier }),
  })
}
function wireQuestion(name: string, question: DecisionQuestion): object {
  const instructions = decisionText(question.instructions)
  switch (question.type) {
    case 'choice': return { type: 'choice', name, instructions,
      choices: Object.entries(question.options).map(([value, detail]) => ({ value,
        ...(detail === null ? {} : { description: decisionText(detail) }) })) }
    case 'score': return { type: 'score', name, instructions,
      levels: question.levels.map((detail, index) => ({ label: String(index), description: decisionText(detail) })) }
    case 'boolean': return { type: 'predicate', name, instructions: question.criteria === undefined ? instructions
      : `${instructions}\n\nBoolean criteria (true and false):\n${JSON.stringify(question.criteria)}` }
  }
}
