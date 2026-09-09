/** Node-only filesystem-backed Agent Skills capability. */

export {
  discoverFileSystemSkills,
  fileSystemSkills,
  type FileSystemSkillIoEvent,
  type FileSystemSkillIoPhase,
  type FileSystemSkillRoot,
  type FileSystemSkillsOptions,
} from './provider/filesystem-provider.ts'
export { fileSystemSkillProviderPlugin } from './provider/plugin.ts'
