import { MAX_SKILL_RESOURCE_CHARS, MAX_SKILL_INSTRUCTIONS_CHARS } from '@alvin0/ai-agent-sdk-core/skills'

export const TEXT_RESOURCE_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.ts', '.tsx', '.js', '.mjs', '.cjs',
  '.py', '.sh', '.ps1',
])
export const MAX_RESOURCES = 256
export const DEFAULT_MAX_CANDIDATES = 1_024
export const DEFAULT_MAX_ROOT_ENTRIES = 4_096
export const MAX_MANIFEST_ENTRIES = 4_096
export const MAX_MANIFEST_DEPTH = 16
export const IGNORED_RESOURCE_DIRECTORIES = new Set(['.git', 'node_modules'])
export const READ_CHUNK_BYTES = 8 * 1024
export const MAX_FRONT_MATTER_BYTES = 64 * 1024
export const MAX_OPENAI_METADATA_BYTES = 64 * 1024
export const MAX_OPENAI_METADATA_DEPTH = 16
export const MAX_OPENAI_METADATA_NODES = 4_096
export const MAX_SKILL_FILE_BYTES = MAX_FRONT_MATTER_BYTES + MAX_SKILL_INSTRUCTIONS_CHARS * 4
export const MAX_RESOURCE_FILE_BYTES = MAX_SKILL_RESOURCE_CHARS * 4

