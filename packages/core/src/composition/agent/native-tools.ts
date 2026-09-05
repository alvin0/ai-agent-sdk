import type {
  NativeImageGenerationTool, NativeToolSchema, NativeWebSearchTool, ToolChoice, WebSearchLocation,
} from '../../contract/tool.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { arrayData, boundedText, objectValue, ownData } from '../common/data.ts'
import { cloneJsonObject } from '../common/json-data.ts'

const LIMITS = Object.freeze({ tools: 128, domains: 128, textBytes: 1_024 })
const ERROR_CODE = 'NATIVE_TOOL_CONFIG_INVALID'

/** Validate and detach provider-native configuration before model resolution/dispatch. */
export function captureNativeTools(value: unknown): readonly NativeToolSchema[] {
  if (value === undefined) return Object.freeze([])
  try {
    return Object.freeze(arrayData(value, LIMITS.tools).map(entry => captureNativeTool(entry)))
  } catch (error) {
    if (error instanceof AgentSdkError && error.code === ERROR_CODE) throw error
    throw invalid(error)
  }
}

export function captureToolChoice(value: unknown): ToolChoice | undefined {
  if (value === undefined) return undefined
  if (value === 'auto' || value === 'none' || value === 'required') return value
  try {
    const source = objectValue(value)
    exactKeys(source, ['type', 'name'])
    const type = ownData(source, 'type'), name = boundedText(ownData(source, 'name'), LIMITS.textBytes)
    if (type === 'tool') return Object.freeze({ type, name })
    if (type === 'native' && (name === 'web-search' || name === 'image-generation')) {
      return Object.freeze({ type, name })
    }
    throw invalid()
  } catch (error) { throw invalid(error) }
}

function captureNativeTool(value: unknown): NativeToolSchema {
  const source = objectValue(cloneJsonObject(value))
  if (ownData(source, 'type') !== 'native') throw invalid()
  const name = ownData(source, 'name')
  if (name === 'web-search') return webSearch(source)
  if (name === 'image-generation') return imageGeneration(source)
  throw invalid()
}

function webSearch(source: object): NativeWebSearchTool {
  exactKeys(source, ['type', 'name', 'searchContextSize', 'allowedDomains', 'blockedDomains', 'userLocation', 'maxUses'])
  const context = ownData(source, 'searchContextSize', false)
  if (context !== undefined && context !== 'low' && context !== 'medium' && context !== 'high') throw invalid()
  const allowedDomains = domains(ownData(source, 'allowedDomains', false))
  const blockedDomains = domains(ownData(source, 'blockedDomains', false))
  const userLocation = location(ownData(source, 'userLocation', false))
  const maxUses = boundedInteger(ownData(source, 'maxUses', false))
  return Object.freeze({ type: 'native', name: 'web-search',
    ...(context === undefined ? {} : { searchContextSize: context }),
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
    ...(blockedDomains === undefined ? {} : { blockedDomains }),
    ...(userLocation === undefined ? {} : { userLocation }),
    ...(maxUses === undefined ? {} : { maxUses }) })
}

function imageGeneration(source: object): NativeImageGenerationTool {
  exactKeys(source, ['type', 'name', 'size', 'quality', 'format', 'background', 'partialImages'])
  const size = choice(ownData(source, 'size', false), ['auto', '1024x1024', '1536x1024', '1024x1536'])
  const quality = choice(ownData(source, 'quality', false), ['auto', 'low', 'medium', 'high'])
  const format = choice(ownData(source, 'format', false), ['png', 'jpeg', 'webp'])
  const background = choice(ownData(source, 'background', false), ['auto', 'transparent', 'opaque'])
  const partialImages = boundedInteger(ownData(source, 'partialImages', false))
  return Object.freeze({ type: 'native', name: 'image-generation',
    ...(size === undefined ? {} : { size }), ...(quality === undefined ? {} : { quality }),
    ...(format === undefined ? {} : { format }), ...(background === undefined ? {} : { background }),
    ...(partialImages === undefined ? {} : { partialImages }) })
}

function domains(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  return Object.freeze(arrayData(value, LIMITS.domains).map(item => boundedText(item, LIMITS.textBytes)))
}

function location(value: unknown): WebSearchLocation | undefined {
  if (value === undefined) return undefined
  const source = objectValue(value)
  exactKeys(source, ['city', 'region', 'country', 'timezone'])
  const field = (key: string): string | undefined => {
    const entry = ownData(source, key, false)
    return entry === undefined ? undefined : boundedText(entry, LIMITS.textBytes)
  }
  const city = field('city'), region = field('region'), country = field('country'), timezone = field('timezone')
  return Object.freeze({ ...(city === undefined ? {} : { city }), ...(region === undefined ? {} : { region }),
    ...(country === undefined ? {} : { country }), ...(timezone === undefined ? {} : { timezone }) })
}

function boundedInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid()
  return Number(value)
}

function choice<const T extends string>(value: unknown, values: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if (!values.includes(value as T)) throw invalid()
  return value as T
}

function exactKeys(source: object, allowed: readonly string[]): void {
  const expected = new Set(allowed)
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !expected.has(key))) throw invalid()
}

function invalid(cause?: unknown): AgentSdkError {
  return new AgentSdkError('Provider-native tool configuration is invalid', ERROR_CODE,
    cause === undefined ? undefined : { cause })
}
