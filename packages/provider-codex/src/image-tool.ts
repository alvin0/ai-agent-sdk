import { defineTool, ToolError, type JsonValue } from '@alvin0/ai-agent-sdk-core/tools'
import { generateCodexImage } from './image.ts'
import { CodexImageError, parseCodexImageBody } from './image-response.ts'
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
  // value + rendered content both retain base64; leave headroom below the core's 4-MiB result default.
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
    execute: async ({ prompt }, context): Promise<JsonValue> => {
      const result = await generateCodexImage({ ...captured, prompt, signal: context.signal })
        .catch((error: unknown) => {
          if (error instanceof CodexImageError) throw ToolError.respondToModel(error.message, error.code)
          throw error
        })
      // Keep the persisted value JSON, and render actual image blocks for history and UI events.
      return { data: result.images.map(image => {
        if (image.source.kind !== 'base64') throw new TypeError('Codex Images requires inline image output')
        return { b64_json: image.source.data }
      }) }
    },
    render: value => parseCodexImageBody(value).images,
  })
}
