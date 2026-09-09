/** Node-only filesystem-backed AGENTS.md context section. */

export {
  createProjectInstructionsSection,
  type ProjectInstructionsSection,
} from './section.ts'
export {
  DEFAULT_FILE_NAMES, DEFAULT_INTRO, DEFAULT_MAX_BYTES, DEFAULT_MAX_NESTED_DIRS,
  DEFAULT_MAX_TRACKED_SCOPES, DEFAULT_PROJECT_ROOT_MARKERS, DEFAULT_RETRACTION,
  DEFAULT_SECTION_ID, defaultFilePathFromTouch,
  type InstructionToolTouch, type ProjectInstructionsOptions,
} from './config.ts'
export {
  ancestorChain, byDepthThenPath, descendantDirsBetween, findProjectRoot,
  type LoadedInstructionFile,
} from './discovery.ts'
export { dedupeByContent, renderInstructions, type RenderedInstructions } from './render.ts'
