import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIVE_RESEARCH_INSTRUCTIONS } from '../../test-human/edge-chat/live/instructions.ts'

const FOUNDRY_PROMPT = resolve(
  'test-human/edge-chat/live/prompts/microsoft-foundry-agent-service.vi.md',
)

describe('Edge live deep-research prompt isolation', () => {
  it('keeps the reusable agent instruction free of task-specific evidence seeds', () => {
    expect(LIVE_RESEARCH_INSTRUCTIONS).not.toMatch(/https?:\/\//u)
    expect(LIVE_RESEARCH_INSTRUCTIONS).not.toMatch(/Microsoft|Foundry|Azure/u)
    expect(LIVE_RESEARCH_INSTRUCTIONS).toContain(
      "Treat the user's task as a set of questions and output requirements, never as factual evidence.",
    )
  })

  it('keeps the Microsoft benchmark in the user prompt within the browser/Worker limit', async () => {
    const prompt = (await readFile(FOUNDRY_PROMPT, 'utf8')).trim()
    expect(prompt).toBe('Nếu một doanh nghiệp đang xây dựng một nền tảng AI Agent có Agent, Workflow, Tool, Skill, MCP, A2A, RAG/Knowledge, Memory, Observability và Evaluation, liệu có nên đưa toàn bộ hệ thống lên Microsoft Foundry hay vẫn nên duy trì một phần kiến trúc bằng custom code/runtime riêng?')
    expect(prompt.length).toBeLessThanOrEqual(32_000)
    expect(prompt).not.toMatch(/https?:\/\//u)
  })
})
