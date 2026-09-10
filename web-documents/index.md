---
layout: home
title: AI Agent SDK
titleTemplate: false

hero:
  name: AI Agent SDK
  text: Provider-neutral TypeScript SDK
  tagline: One message model, one streaming protocol, one error taxonomy — across Anthropic Messages, OpenAI Responses, Gemini Interactions, and the ChatGPT-backed Codex endpoint.
  actions:
    - theme: brand
      text: English documentation
      link: /en/
    - theme: alt
      text: Tài liệu tiếng Việt
      link: /vi/

features:
  - title: Streaming-only by design
    details: No separate non-streaming path that could drift from the streaming one. When you want a single value, you await the assembled message.
  - title: Capability packages, not a monolith
    details: Twenty-one published packages, each with a declared runtime tier. An Edge worker installs three; a Node coding harness installs six.
  - title: A real agent loop
    details: Immutable history, staged tool dispatch, bounded parallel scheduling, approvals, durability checkpoints, and a backpressured event stream.
  - title: Missing data stays missing
    details: Token usage a provider did not report is missing or partial — never a fabricated zero. A budget that cannot be measured says so.
---
