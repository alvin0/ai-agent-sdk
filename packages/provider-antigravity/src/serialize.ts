import { ModelError, isNativeToolSchema, type ContentBlock, type Message } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest } from '@alvin0/ai-agent-sdk-provider-http'
import { object } from './http.ts'
import { antigravityResponseSchema } from './response-schema.ts'
import { isAntigravityImageModel } from './image.ts'

type Part = Record<string, unknown>

function invalid(message: string): never {
  throw new ModelError(`Antigravity: ${message}`, 'INVALID_REQUEST')
}

function argumentsObject(raw: string): Record<string, unknown> {
  try { return object(JSON.parse(raw) as unknown) }
  catch { return invalid('function-call arguments must be a JSON object') }
}

function replaySignature(message: Message, index: number): Part {
  if (message.source.kind !== 'model') return {}
  const state = message.source.replayState as { response?: { protocol?: string }; blocks?: Part[] } | undefined
  if (state?.response?.protocol !== 'antigravity') return {}
  return replayBlockSignature(state.blocks?.[index], message.content[index])
}

function replayBlockSignature(metadata: Part | undefined, block: ContentBlock | undefined): Part {
  // History policies can replace image bytes with a text placeholder. Its old
  // image signature must not be attached to unrelated text during replay.
  if (metadata?.blockType === 'image' && block?.type !== 'image') return {}
  const signature = metadata?.thoughtSignature
  return typeof signature === 'string' ? { thoughtSignature: signature } : {}
}

function textPart(text: string): Part | undefined {
  // Empty protobuf strings disappear on the Cloud Code -> Claude bridge,
  // turning a trailing empty text part into a malformed Claude text block.
  return text.length === 0 ? undefined : { text }
}

function partOf(block: ContentBlock, toolNames: ReadonlyMap<string, string>): Part | undefined {
  switch (block.type) {
    case 'text': return textPart(block.text)
    case 'reasoning': {
      const state = block.providerState as { thoughtSignature?: unknown } | undefined
      // Unsigned reasoning from another provider is not replayable on this endpoint.
      if (typeof state?.thoughtSignature !== 'string') return undefined
      return { thought: true, text: block.text, thoughtSignature: state.thoughtSignature }
    }
    case 'image':
    case 'document':
      if (block.source.kind !== 'base64') return invalid('images and documents require inline base64 data')
      return { inlineData: { mimeType: block.source.mediaType, data: block.source.data } }
    case 'tool-call':
      return { functionCall: { id: block.id, name: block.name, args: argumentsObject(block.arguments) } }
    case 'tool-result': return toolResult(block, toolNames)
    default: return invalid(`unsupported content block ${block.type}`)
  }
}

function toolResult(
  block: Extract<ContentBlock, { type: 'tool-result' }>, toolNames: ReadonlyMap<string, string>,
): Part {
  const name = toolNames.get(block.toolCallId)
  if (name === undefined) return invalid('tool result has no matching function call')
  const parts = block.content.flatMap(part => {
    if (part.type === 'text') return []
    if (part.type !== 'image' || part.source.kind !== 'base64') return invalid('tool media requires inline images')
    return [{ inlineData: { mimeType: part.source.mediaType, data: part.source.data } }]
  })
  const output = block.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  return { functionResponse: { id: block.toolCallId, name,
    ...(parts.length ? { parts } : {}), response: block.isError ? { error: output } : { output } } }
}

function contentsOf(request: ProtocolRequest): Part[] {
  const toolNames = new Map<string, string>()
  const contents: { role: string; parts: Part[] }[] = []
  for (const message of request.options.messages) {
    for (const block of message.content) if (block.type === 'tool-call') toolNames.set(block.id, block.name)
    if (message.role === 'system') continue
    const parts = message.content.flatMap((block, index) => {
      const signature = replaySignature(message, index)
      if (block.type === 'text' && block.text === '' && signature.thoughtSignature !== undefined) {
        return [{ text: '', ...signature }]
      }
      const part = partOf(block, toolNames)
      return part === undefined ? [] : [{ ...part, ...signature }]
    })
    if (!parts.length) continue
    const role = message.role === 'assistant' ? 'model' : 'user'
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  return contents
}

function imageOutputConfig(request: ProtocolRequest): Part {
  const image = isAntigravityImageModel(request.options.model)
    || request.model.outputModalities?.includes('image') === true
  return image ? { responseModalities: ['TEXT', 'IMAGE'] } : {}
}

function generationConfig(request: ProtocolRequest): Part {
  const options = request.options
  return {
    ...imageOutputConfig(request),
    ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.topP === undefined ? {} : { topP: options.topP }),
    ...(options.stop === undefined ? {} : { stopSequences: [...options.stop] }),
    ...(options.reasoningEffort === undefined ? {} : {
      thinkingConfig: { thinkingLevel: String(options.reasoningEffort).toUpperCase(), includeThoughts: true },
    }),
    ...(options.outputFormat?.type !== 'json_schema' ? {} : {
      responseMimeType: 'application/json', responseSchema: antigravityResponseSchema(options.outputFormat.schema),
    }),
  }
}

function toolChoiceConfig(choice: ProtocolRequest['options']['toolChoice']): Part | undefined {
  if (choice === undefined) return undefined
  if (typeof choice === 'object' && choice.type === 'native') return invalid('native tool choice is unsupported')
  let mode = 'AUTO'
  if (choice === 'required' || typeof choice === 'object') mode = 'ANY'
  if (choice === 'none') mode = 'NONE'
  return { functionCallingConfig: { mode,
    ...(typeof choice === 'object' ? { allowedFunctionNames: [choice.name] } : {}),
  } }
}

export function serializeAntigravityRequest(request: ProtocolRequest): Part {
  const options = request.options
  const system = [options.system, ...options.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text)]
    .filter(Boolean).join('\n\n')
  const declarations = options.tools?.map(tool => {
    if (isNativeToolSchema(tool)) return invalid('provider-native tools are not supported on this route')
    return { name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters }
  })
  const toolConfig = toolChoiceConfig(options.toolChoice)
  return {
    contents: contentsOf(request), generationConfig: generationConfig(request),
    ...(system ? { systemInstruction: { role: 'user', parts: [{ text: system }] } } : {}),
    ...(declarations?.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
    ...(toolConfig === undefined ? {} : { toolConfig }),
  }
}
