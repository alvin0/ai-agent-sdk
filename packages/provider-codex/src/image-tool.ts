import type { ImageMediaType } from '@alvin0/ai-agent-sdk-core'
import { defineTool, ToolError, type JsonValue } from '@alvin0/ai-agent-sdk-core/tools'
import { generateCodexImage } from './image.ts'
import { CodexImageError } from './image-response.ts'
import { CodexRefreshError } from './oauth-errors.ts'
import type { CodexImageOptions } from './image-types.ts'

interface ImageArgs { prompt: string }

function parseArgs(raw: unknown): ImageArgs {
  if (typeof raw !== 'object' || raw === null || !('prompt' in raw)
    || typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0) {
    throw new TypeError('codex_generate_image requires a non-empty prompt')
  }
  return { prompt: raw.prompt }
}

/** Opt-in host tool. Configure the image model and credentials outside model-controlled arguments. */
export function codexImageTool(options: CodexImageOptions) {
  // Render the image once and let core retain only its policy-managed content block.
  const captured = { ...options, maxBytes: options.maxBytes ?? 2_000_000,
    ...(options.oauth === undefined ? {} : { oauth: { ...options.oauth } }) }
  return defineTool<ImageArgs>({
    name: 'codex_generate_image',
    description: 'Generate an image from a prompt using the connected Codex account. Returns image content.',
    parameters: {
      type: 'object', properties: { prompt: { type: 'string', minLength: 1 } },
      required: ['prompt'], additionalProperties: false,
    },
    parse: parseArgs,
    timeoutMs: options.timeoutMs ?? 180_000,
    omitResultValue: true,
    execute: async ({ prompt }, context): Promise<JsonValue> => {
      const result = await generateCodexImage({ ...captured, prompt, signal: context.signal })
        .catch((error: unknown) => {
          context.signal.throwIfAborted()
          if (captured.oauth?.signal?.aborted) {
            throw ToolError.respondToModel('Image generation was cancelled', 'ABORTED')
          }
          if (error instanceof CodexRefreshError) {
            throw ToolError.respondToModel('Codex credential refresh failed', error.code, { cause: error })
          }
          if (error instanceof CodexImageError) throw ToolError.respondToModel(error.message, error.code)
          throw ToolError.respondToModel('Codex image credentials are unavailable',
            'CODEX_IMAGE_CREDENTIAL', { cause: error })
        })
      return result.images.map(image => {
        if (image.source.kind !== 'base64') throw new TypeError('Codex Images requires inline output')
        return { mediaType: image.source.mediaType, data: image.source.data }
      })
    },
    render: value => (value as { mediaType: ImageMediaType; data: string }[])
      .map(source => ({ type: 'image', source: { kind: 'base64', ...source } })),
  })
}
