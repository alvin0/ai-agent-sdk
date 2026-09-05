import type {
  SkillDefinition,
  SkillProvider,
  SkillProviderListOptions,
  SkillProviderPlugin,
} from '@ai-agent-sdk/core/skills'

export interface FileSystemSkillRoot {
  readonly path: string
  readonly source?: string
}

export type FileSystemSkillIoPhase = 'discovery' | 'activation' | 'resource'

export interface FileSystemSkillIoEvent {
  readonly phase: FileSystemSkillIoPhase
  readonly operation: 'read' | 'scan'
  readonly path: string
  readonly skillId?: string
  readonly bytesRead: number
  readonly entriesScanned?: number
}

export interface FileSystemSkillsOptions {
  readonly id?: string
  readonly roots?: readonly (string | FileSystemSkillRoot)[]
  readonly cwd?: string
  readonly includeProjectAgents?: boolean
  readonly includeProjectDsh?: boolean
  readonly includeUserAgents?: boolean
  readonly maxCandidates?: number
  readonly maxRootEntries?: number
  readonly onIo?: (event: FileSystemSkillIoEvent) => void
}

/** Returns a lazy borrowed provider; filesystem access begins only on list/load/resource calls. */
export declare function fileSystemSkills(options?: FileSystemSkillsOptions): SkillProvider

/** Additive marker-based adapter for the high-level runtime composition slot. */
export declare function fileSystemSkillProviderPlugin(
  options?: FileSystemSkillsOptions,
): SkillProviderPlugin

export declare function discoverFileSystemSkills(
  options?: FileSystemSkillsOptions & SkillProviderListOptions,
): Promise<readonly SkillDefinition[]>
