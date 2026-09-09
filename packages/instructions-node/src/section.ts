/**
 * The filesystem-backed {@link ContextSection} itself.
 *
 * @module @alvin0/ai-agent-sdk-instructions-node/section
 */

import { resolve } from 'node:path'
import { defineContextSection } from '@alvin0/ai-agent-sdk-core'
import type { ContextSection, ContextSectionScope, ContextSectionState } from '@alvin0/ai-agent-sdk-core'
import {
  resolveInstructionsConfig,
  type ProjectInstructionsOptions,
  type ResolvedInstructionsConfig,
} from './config.ts'
import {
  ancestorChain, byDepthThenPath, descendantDirsBetween, directoryInstructionFiles, findProjectRoot,
  globalInstructionFile, type LoadedInstructionFile,
} from './discovery.ts'
import { dedupeByContent, renderInstructions } from './render.ts'

/**
 * Discover every instruction file currently in scope.
 * @param config - normalized configuration.
 * @param extraDirs - descendant directories a tool call reached into.
 * @returns files in broad-to-specific precedence order.
 */
async function discover(
  config: ResolvedInstructionsConfig,
  extraDirs: readonly string[],
  signal: AbortSignal,
): Promise<{ files: LoadedInstructionFile[]; projectRoot: string }> {
  const cwd = resolve(config.cwd)
  const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers, signal)
  const files: LoadedInstructionFile[] = []
  const global = await globalInstructionFile(config)
  if (global !== undefined) files.push(global)
  const seen = new Set(ancestorChain(projectRoot, cwd))
  const dirs = [...seen]
  // Nested directories come after the chain and shallowest-first, so a deeper
  // file still reads as the more specific one.
  for (const dir of [...extraDirs].sort(byDepthThenPath)) {
    if (seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  for (const dir of dirs) {
    files.push(...await directoryInstructionFiles(dir, projectRoot, config, signal))
  }
  return { files, projectRoot }
}

export interface ProjectInstructionsSection extends ContextSection {
  /**
   * Absolute paths rendered for one conversation, for host diagnostics.
   * @param scope - the conversation to report on; defaults to the unscoped one.
   * @returns the paths in the order they were rendered.
   */
  loadedPaths(scope?: ContextSectionScope): readonly string[]
}

/** Mutable state one conversation accumulates. */
interface ScopeState {
  readonly nestedDirs: Set<string>
  nestedLimitReported: boolean
  loaded: readonly string[]
}

function scopeKey(scope: ContextSectionScope | undefined): string {
  return `${scope?.agentId ?? ''}\u0000${scope?.conversationId ?? ''}`
}

/**
 * Build the AGENTS.md-compatible context section.
 *
 * Discovery walks up from `cwd` to the project root, reads the configured
 * candidates from the root down, and — once a tool touches a file below `cwd` —
 * adds that subtree's instruction files too. Content is rendered into one
 * surface node; the loop rewrites it only when the digest changes.
 *
 * One instance is safe to mount on a definition that many sessions instantiate.
 * Everything it accumulates is keyed by the conversation scope the loop hands
 * to `resolve`, so a team member that reads into `packages/api` does not put
 * that directory's instructions in front of its peers. Sessions with no trace
 * identity — a bare `runTurn` — share one unscoped bucket.
 *
 * ```ts
 * const agent = defineAgent({
 *   id: 'coder',
 *   instructions: 'You are a coding agent.',
 *   contextSections: [createProjectInstructionsSection({ cwd: process.cwd() })],
 * })
 * ```
 * @param options - discovery, budget, and rendering controls.
 * @returns a section ready to mount on an agent or a session.
 */
export function createProjectInstructionsSection(
  options: ProjectInstructionsOptions = {},
): ProjectInstructionsSection {
  const config = resolveInstructionsConfig(options, process.cwd())
  // Insertion-ordered, so the first key is the least recently created bucket.
  const scopes = new Map<string, ScopeState>()

  const stateFor = (scope: ContextSectionScope | undefined): ScopeState => {
    const key = scopeKey(scope)
    const existing = scopes.get(key)
    if (existing !== undefined) {
      // Refresh recency so an active conversation is never the one evicted.
      scopes.delete(key)
      scopes.set(key, existing)
      return existing
    }
    const created: ScopeState = {
      nestedDirs: new Set<string>(), nestedLimitReported: false, loaded: Object.freeze([]),
    }
    scopes.set(key, created)
    while (scopes.size > config.maxTrackedScopes) {
      const oldest = scopes.keys().next()
      if (oldest.done === true) break
      scopes.delete(oldest.value)
    }
    return created
  }

  const section = defineContextSection({
    id: config.id,
    retractionText: config.retractionText,
    async resolve(input): Promise<ContextSectionState | undefined> {
      const state = stateFor(input.scope)
      if (config.nested) {
        for (const touch of input.touches) {
          const path = config.filePathFromTouch(touch)
          if (path === undefined) continue
          for (const dir of descendantDirsBetween(config.cwd, path)) {
            // Every retained directory is re-probed on every model round. An
            // agent that walks a large tree would otherwise turn one section
            // into thousands of stat calls per step, so the set is capped and
            // the directories already in scope win.
            if (state.nestedDirs.size >= config.maxNestedDirs) {
              if (!state.nestedLimitReported) {
                state.nestedLimitReported = true
                config.onNestedLimit?.(config.maxNestedDirs)
              }
              break
            }
            state.nestedDirs.add(dir)
          }
        }
      }
      input.signal.throwIfAborted()
      const { files } = await discover(config, [...state.nestedDirs], input.signal)
      const rendered = renderInstructions(dedupeByContent(files), config)
      if (rendered === undefined) {
        state.loaded = Object.freeze([])
        return undefined
      }
      state.loaded = Object.freeze(rendered.included.map(file => file.absolutePath))
      return { revision: rendered.revision, text: rendered.text }
    },
  })

  return Object.freeze({
    ...section,
    loadedPaths: (scope?: ContextSectionScope) => scopes.get(scopeKey(scope))?.loaded ?? Object.freeze([]),
  })
}
