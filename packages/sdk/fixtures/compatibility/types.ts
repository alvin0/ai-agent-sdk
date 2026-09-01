export type CompatibilityModules = [
  typeof import('ai-agent-sdk'),
  typeof import('ai-agent-sdk/anthropic'),
  typeof import('ai-agent-sdk/openai'),
  typeof import('ai-agent-sdk/codex'),
  typeof import('ai-agent-sdk/a2a-client'),
  typeof import('ai-agent-sdk/a2a-server'),
  typeof import('ai-agent-sdk/skill-filesystem'),
  typeof import('ai-agent-sdk/request-logger'),
  typeof import('ai-agent-sdk/mcp-client'),
  typeof import('ai-agent-sdk/mcp-server'),
  typeof import('ai-agent-sdk/mcp-node'),
  typeof import('ai-agent-sdk/node'),
]
