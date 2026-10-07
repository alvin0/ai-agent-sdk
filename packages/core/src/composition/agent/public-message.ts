import { freezeMessage, type Message, type ContentBlock } from '../../message/index.ts'

export function publicMessage(message: Message): Message {
  const source = message.source.kind === 'model'
    ? { kind: 'model' as const, provider: message.source.provider, model: message.source.model }
    : message.source
  return freezeMessage({ ...message, source, content: publicContent(message.content) })
}

export function publicContent(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.map(block => {
    const { providerState: _state, ...content } = block as typeof block & { providerState?: unknown }
    if (content.type === 'text' && content.annotations !== undefined) return { ...content,
      annotations: content.annotations.map(({ providerState: _state, ...annotation }) => annotation) }
    if (content.type === 'native-tool-call'
      || content.type === 'tool-result') return { ...content, content: publicContent(content.content) }
    return content
  })
}
