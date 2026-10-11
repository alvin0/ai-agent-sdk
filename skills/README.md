# Skills shipped with this SDK

## `ai-agent-sdk`

A capability skill that teaches an AI coding agent how to build with the
`@alvin0/ai-agent-sdk-*` packages. Point your agent at it instead of pasting
documentation into a prompt.

```
skills/ai-agent-sdk/
  SKILL.md                        entry point: the five rules, one working
                                  program, a trap index, and a routing table
  references/
    packages.md                   package matrix, runtime tiers, credentials, limits
    runtime-and-agents.md         createAgentRuntime, agents, both session layers
    streaming.md                  run events, live UI, cancellation, completion
    tools.md                      defineTool, scheduling, approvals, interceptors
    decision.md                   typed decisions and native OpenAI transport
    prompt-caching.md             stable cache keys and provider policy
    context-optimization.md       observation packing and evidence reduction
    sandbox.md                    command policy and process confinement
    upgrading-to-0.1.12.md         current migration and compatibility checklist
    structured-output.md          outputFormat and its bounds
    skills.md                     progressive disclosure, both provider contracts
    memory.md                     task memory, compaction, snapshots
    orchestration.md              flows, modes, teams, gates
    providers.md                  dialects, auth schemes, authoring a provider
    context-and-instructions.md   authority model, context sections, AGENTS.md
    messages-and-content.md       message model, content blocks, images
    budgets-and-usage.md          limits, usage coverage, spill store
    mcp.md                        consume and publish MCP
    a2a.md                        remote agents, agent cards, team roster
    observability.md              bus, exporters, correlation ids
    errors.md                     error codes, retry policy
    testing.md                    testing an agent with no live provider
    troubleshooting.md            symptom to cause, including type errors
    deploy.md                     Node CLI, Edge/Worker, browser
```

`SKILL.md` stays small on purpose. Each reference is self-contained, so an agent
loads one file for the task in front of it rather than the whole manual.

## Using it with Claude Code

```bash
# Run from a clone of https://github.com/alvin0/ai-agent-sdk:
mkdir -p /path/to/your/project/.claude/skills
cp -R skills/ai-agent-sdk /path/to/your/project/.claude/skills/
```

The npm SDK tarballs do not include this repository skill. Copy the whole
folder, including `references/`, from a checkout matching your SDK version.

The skill is then discovered by name (`ai-agent-sdk`). Any agent runtime that
reads a `SKILL.md` front-matter contract can consume it unchanged; the same
folder also works as a `defineSkill()` resource bundle or a
`fileSystemSkillProviderPlugin({ roots: ['./skills'] })` root inside an agent
built on this SDK.

## How these files are kept honest

Use current source and built declarations to verify API examples. Validate the
skill frontmatter and relative reference links, then run `pnpm check:docs` and
`pnpm docs:build` for README and bilingual site checks. Those gates do not compile
every Markdown snippet or prove live-provider behavior; typecheck changed runnable
examples separately when their API usage changes.
