import { userInputResponseProblem, type UserInputQuestion, type UserInputResponse  } from '../user-input.ts'
import { record, requiredString  } from './validation.ts'

export function validateUserResponse(
  response: UserInputResponse,
  questions: readonly UserInputQuestion[],
): UserInputResponse {
  const problem = userInputResponseProblem(questions, response)
  if (problem !== undefined) throw new Error(`the user-input broker returned ${problem}`)
  return response
}

export function parseUserInput(raw: unknown): { readonly questions: readonly UserInputQuestion[] } {
  const value = record(raw, 'request_user_input arguments')
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 3) {
    throw new Error('questions must contain one to three items')
  }
  const ids = new Set<string>()
  const questions = value.questions.map((rawQuestion, index) => {
    const question = record(rawQuestion, `questions[${index}]`)
    const id = requiredString(question.id, `questions[${index}].id`)
    if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`questions[${index}].id must be snake_case`)
    if (ids.has(id)) throw new Error(`question id "${id}" is duplicated`)
    ids.add(id)
    const header = requiredString(question.header, `questions[${index}].header`)
    const prompt = requiredString(question.question, `questions[${index}].question`)
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3) {
      throw new Error(`questions[${index}].options must contain two or three choices`)
    }
    const options = question.options.map((rawOption, optionIndex) => {
      const option = record(rawOption, `questions[${index}].options[${optionIndex}]`)
      return {
        label: requiredString(option.label, `questions[${index}].options[${optionIndex}].label`),
        description: requiredString(option.description, `questions[${index}].options[${optionIndex}].description`),
      }
    })
    return Object.freeze({ id, header, question: prompt, options: Object.freeze(options),
      allowFreeForm: true as const })
  })
  return { questions: Object.freeze(questions) }
}

export function requestUserInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      questions: {
        type: 'array', minItems: 1, maxItems: 3,
        description: 'Questions to show the user. Prefer one and do not exceed three.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Stable snake_case answer key.' },
            header: { type: 'string', description: 'Short UI label, ideally 12 characters or fewer.' },
            question: { type: 'string', description: 'Single-sentence question.' },
            options: {
              type: 'array', minItems: 2, maxItems: 3,
              description: 'Mutually exclusive choices. Put the recommended choice first and suffix its label '
                + 'with "(Recommended)". '
                + 'Do not add Other; the client supplies free-form input.',
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  label: { type: 'string', description: 'User-facing label, one to five words.' },
                  description: { type: 'string', description: 'One sentence explaining impact or trade-off.' },
                },
                required: ['label', 'description'],
              },
            },
          },
          required: ['id', 'header', 'question', 'options'],
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  }
}
