import {
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_ID_CHARS,
  MAX_SKILL_INSTRUCTIONS_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_RESOURCE_CHARS,
  MAX_SKILL_RESOURCE_PATH_CHARS,
  SKILL_ID_PATTERN,
  SKILL_TOOL_NAMES,
  SkillCatalog,
  createSkillTools,
  defineSkill,
  defineSkillProvider,
  renderSkillCatalog,
  resolveSkillOptions,
  validateSkillId,
  validateSkillSource,
  type AgentSkillOptions,
  type ResolvedAgentSkillOptions,
  type SkillCandidate,
  type SkillCatalogOptions,
  type SkillDefinition,
  type SkillDefinitionInput,
  type SkillInvocationPolicy,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderListOptions,
  type SkillResourceBase,
  type SkillResourceSummary,
  type SkillSource,
  type SkillSummary,
} from '@ai-agent-sdk/core/agent'

type Equivalent<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left] ? true : false
    : false
type Assert<Value extends true> = Value

export type AgentSkillApiShape = [
  Assert<Equivalent<SkillResourceBase['kind'], 'directory' | 'url' | 'opaque'>>,
  Assert<Equivalent<typeof MAX_SKILL_INSTRUCTIONS_CHARS, 40000>>,
  Assert<Equivalent<typeof MAX_SKILL_RESOURCE_CHARS, 40000>>,
  Assert<Equivalent<typeof MAX_SKILL_ID_CHARS, 128>>,
  Assert<Equivalent<typeof MAX_SKILL_NAME_CHARS, 256>>,
  Assert<Equivalent<typeof MAX_SKILL_DESCRIPTION_CHARS, 2048>>,
  Assert<Equivalent<typeof MAX_SKILL_RESOURCE_PATH_CHARS, 512>>,
]

export type AgentSkillTypeInventory = [
  AgentSkillOptions,
  ResolvedAgentSkillOptions,
  SkillCandidate,
  SkillCatalogOptions,
  SkillDefinition,
  SkillDefinitionInput,
  SkillInvocationPolicy,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderListOptions,
  SkillResourceSummary,
  SkillSource,
  SkillSummary,
]

const direct = defineSkill({
  id: 'compatibility-skill',
  description: 'Compatibility skill.',
  instructions: 'Return a compact result.',
})

const provider = defineSkillProvider({
  kind: 'skill-provider',
  id: 'compatibility-skills',
  async list(_options) {
    return [{
      id: direct.id,
      name: direct.name,
      description: direct.description,
      invocation: direct.invocation,
      source: direct.source,
      provider: 'compatibility-skills',
      locator: { id: direct.id },
    }]
  },
  async load(candidate, _options) {
    return candidate.id === direct.id ? direct : undefined
  },
  async readResource(_candidate, _path, _options) { return undefined },
})

/** Representative legacy provider/catalog source compiled unchanged on both modules. */
export async function exerciseAgentSkillApi(signal: AbortSignal): Promise<void> {
  validateSkillId(direct.id)
  validateSkillSource(provider)
  void SKILL_ID_PATTERN.test(direct.id)
  void SKILL_TOOL_NAMES
  const catalog = new SkillCatalog([direct, provider], {
    allowedSkillIds: [direct.id],
    maxSkills: 16,
    maxCatalogBytes: 4096,
  })
  const summaries = await catalog.discover({ signal })
  const options = resolveSkillOptions({ maxCatalogChars: 1024 })
  void renderSkillCatalog('base', summaries, options)
  void createSkillTools(catalog, options, () => ({ signal }))
  void await catalog.load(direct.id, { signal })
  void await catalog.activate(direct.id, { signal })
  void catalog.summaries()
  void catalog.activatedSummaries()
  void catalog.activatedResources(direct.id)
  void catalog.isActivated(direct.id)
  void await catalog.readResource(direct.id, 'resource.md', { signal })
  catalog.clearActivations()
}
