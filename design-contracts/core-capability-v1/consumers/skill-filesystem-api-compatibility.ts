import {
  discoverFileSystemSkills,
  fileSystemSkills,
  type FileSystemSkillIoEvent,
  type FileSystemSkillIoPhase,
  type FileSystemSkillRoot,
  type FileSystemSkillsOptions,
} from '@compat/skill-filesystem'

export type FileSystemSkillCompatibilityTypes = [
  FileSystemSkillIoEvent,
  FileSystemSkillIoPhase,
  FileSystemSkillRoot,
  FileSystemSkillsOptions,
]

const options: FileSystemSkillsOptions = {
  roots: [{ path: '/fixture/skills', source: 'fixture' }],
  maxCandidates: 1_024,
  maxRootEntries: 4_096,
  onIo(event) { void event.bytesRead },
}

export const compatibleFileSystemSkillProvider = fileSystemSkills(options)
export const compatibleFileSystemSkillDiscovery = discoverFileSystemSkills({
  ...options,
  allowedSkillIds: ['fixture-skill'],
})
