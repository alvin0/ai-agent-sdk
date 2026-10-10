import { type SkillDefinitionInput } from '@alvin0/ai-agent-sdk-core/skills'

export interface FileSystemSkillRoot {
  readonly path: string
  readonly source?: string
}

export type FileSystemSkillIoPhase = 'discovery' | 'activation' | 'resource'

/** Optional byte-level telemetry for acceptance tests and host diagnostics. */
export interface FileSystemSkillIoEvent {
  readonly phase: FileSystemSkillIoPhase
  readonly operation: 'read' | 'scan'
  readonly path: string
  readonly skillId?: string
  readonly bytesRead: number
  readonly entriesScanned?: number
}

export interface FileSystemSkillsOptions {
  /** Provider identity used in catalogs and diagnostics. Defaults to filesystem. */
  readonly id?: string
  /** Exact ordered roots. Earlier roots win duplicate ids. */
  readonly roots?: readonly (string | FileSystemSkillRoot)[]
  /** Base for automatic project discovery. Defaults to lookup cwd, then process.cwd(). */
  readonly cwd?: string
  /** Scan `.agents/skills` from cwd through the git root. Defaults to true when roots are omitted. */
  readonly includeProjectAgents?: boolean
  /** Also scan `.dsh/skills` along the same project chain. Defaults to false. */
  readonly includeProjectDsh?: boolean
  /** Add `$HOME/.agents/skills` after project roots. Defaults to false for hermetic SDK usage. */
  readonly includeUserAgents?: boolean
  /** Hard cap for metadata candidates retained by one provider. Defaults to 1024. */
  readonly maxCandidates?: number
  /** Hard cap for directory entries scanned per discovery root. Defaults to 4,096. */
  readonly maxRootEntries?: number
  /** Observe bounded filesystem I/O without changing discovery semantics. */
  readonly onIo?: (event: FileSystemSkillIoEvent) => void
}

export interface ResolvedRoot {
  readonly path: string
  readonly source: string
}

export interface FileLocator {
  readonly skillFile: string
  readonly directory: string
}

export interface ParsedSkillFile {
  readonly input: SkillDefinitionInput
}


export interface FileSystemIoOptions {
  signal: AbortSignal | undefined
  onIo: FileSystemSkillsOptions['onIo']
}
