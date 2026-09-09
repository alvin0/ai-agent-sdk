# Skills shipped with this SDK

## `ai-agent-sdk`

A capability skill that teaches an AI coding agent how to build with the
`@alvin0/ai-agent-sdk-*` packages. Point your agent at it instead of pasting
documentation into a prompt.

```
skills/ai-agent-sdk/
  SKILL.md                        entry point: the five rules, one working
                                  program, and a routing table
  references/
    packages.md                   package matrix, runtime tiers, credentials, limits
    runtime-and-agents.md         createAgentRuntime, agents, both session layers
    streaming.md                  run events, live UI, cancellation, completion
    tools.md                      defineTool, scheduling, approvals, interceptors
    structured-output.md          outputFormat and its bounds
    skills.md                     progressive disclosure, both provider contracts
    memory.md                     task memory, compaction, snapshots
    orchestration.md              flows, modes, teams, gates
    mcp.md                        consume and publish MCP
    a2a.md                        remote agents, agent cards, team roster
    observability.md              bus, exporters, correlation ids
    errors.md                     error codes, retry policy
    deploy.md                     Node CLI, Edge/Worker, browser
```

`SKILL.md` stays small on purpose. Each reference is self-contained, so an agent
loads one file for the task in front of it rather than the whole manual.

## Using it with Claude Code

```bash
mkdir -p .claude/skills
cp -R node_modules/@alvin0/ai-agent-sdk-core/../../skills/ai-agent-sdk .claude/skills/
# or, from a clone of this repository:
cp -R skills/ai-agent-sdk /path/to/your/project/.claude/skills/
```

The skill is then discovered by name (`ai-agent-sdk`). Any agent runtime that
reads a `SKILL.md` front-matter contract can consume it unchanged; the same
folder also works as a `defineSkill()` resource bundle or a
`fileSystemSkillProviderPlugin({ roots: ['./skills'] })` root inside an agent
built on this SDK.

## How these files are kept honest

Every API name the skill imports is checked against the built `.d.ts` files, and
the code paths it teaches are compiled under `--strict`. Where the prose
documentation in `web-documents/` disagreed with the shipped typings, the skill
follows the typings and says so — those spots are called out inline, because
they are exactly where an agent would otherwise write code that does not
compile.
