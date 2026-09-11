/**
 * The two Copilot endpoint constants and the editor-header override type, in the
 * leaf layer so every module that has to speak to the Copilot surface can reach
 * them.
 *
 * They BELONG to `../adapter.ts` — that module is the public door, documents the
 * client-identity tradeoff, and re-exports everything here. The values live one
 * layer down for the same structural reason `COPILOT_ERROR_CODES` does:
 * `../catalog.ts` needs {@link COPILOT_BASE_URL} and `../exchange.ts` needs the
 * two editor headers, while `../adapter.ts` builds the catalog reader and the
 * token cache. Declaring the constants in `../adapter.ts` would make that edge
 * run both ways, which the repo's circular-dependency check forbids. Copying the
 * strings instead would be worse: a client identity that exists in two places is
 * a client identity that can disagree with itself.
 *
 * Read `../adapter.ts` for what these values mean, why they are overridable
 * options rather than hidden constants, and what is still outstanding on each.
 *
 * @module ai-agent-sdk/providers/copilot/identity
 */

/** The Copilot API base. Documented on the re-export in `../adapter.ts`. */
export const COPILOT_BASE_URL = 'https://api.githubcopilot.com'

/** Default `Editor-Version`. Documented on the re-export in `../adapter.ts`. */
export const COPILOT_EDITOR_VERSION = 'vscode/1.99.0'

/** Default `Editor-Plugin-Version`. Documented on the re-export in `../adapter.ts`. */
export const COPILOT_EDITOR_PLUGIN_VERSION = 'copilot-chat/0.26.0'

/**
 * Overrides for the two editor headers.
 *
 * Each field is independent: leaving one undefined keeps that header's exported
 * default rather than dropping the header, because a dropped header is an HTTP
 * 400 rather than a lenient request.
 */
export interface CopilotEditorHeaders {
  /** Overrides {@link COPILOT_EDITOR_VERSION}. */
  readonly editorVersion?: string
  /** Overrides {@link COPILOT_EDITOR_PLUGIN_VERSION}. */
  readonly editorPluginVersion?: string
}

/** Both editor headers resolved, with every field present. */
export interface ResolvedCopilotEditorHeaders {
  /** The value sent as `editor-version`. */
  readonly editorVersion: string
  /** The value sent as `editor-plugin-version`. */
  readonly editorPluginVersion: string
}

/**
 * Resolve each editor header from the override first and the exported default
 * second.
 *
 * Per field rather than per object: an override of one header leaves the other at
 * its default instead of dropping it, because a dropped editor header is an HTTP
 * 400 (Requirement 2.4).
 * @param headers - the caller's overrides, when they set any.
 * @returns both header values, neither of them empty.
 */
export function resolveCopilotEditorHeaders(
  headers: CopilotEditorHeaders | undefined,
): ResolvedCopilotEditorHeaders {
  return Object.freeze({
    editorVersion: headers?.editorVersion ?? COPILOT_EDITOR_VERSION,
    editorPluginVersion: headers?.editorPluginVersion ?? COPILOT_EDITOR_PLUGIN_VERSION,
  })
}
