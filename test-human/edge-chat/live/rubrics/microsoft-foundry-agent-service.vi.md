# Rubric đánh giá: Microsoft Foundry Agent Service

File này chỉ dành cho host-side evaluator và reviewer độc lập. Runner không đọc
file này, Worker không nhận nội dung này và model không được cung cấp các câu hỏi
con, nguồn, status hay kết luận mong đợi dưới đây.

## Ranh giới prompt

User input phải chỉ gồm đúng câu hỏi trong
`../prompts/microsoft-foundry-agent-service.vi.md`. Mọi kết luận phải hình thành
từ search, page reads và audit của agent.

## Phạm vi nội dung cần review

1. Xác định Microsoft Foundry, Agent Service, Models, Tools/Toolboxes, Foundry IQ,
   Microsoft Agent Framework và Responses API; phân biệt Azure AI Foundry,
   Foundry/Agents classic và Assistants API. Kiểm tra GA, Preview, Deprecated,
   Retiring cùng ngày deprecation/retirement.
2. Phân biệt Prompt Agent và Hosted Agent về definition, managed/custom runtime,
   model/tool binding, scale, state/session, identity, versioning, packaging,
   container/ACR và framework support. Xác minh CPU, RAM, sandbox, filesystem,
   persistence/isolation, scale-to-zero, timeout/lifetime, concurrency, rollback
   và traffic splitting.
3. Xác minh execution path và ranh giới trách nhiệm Microsoft/developer của
   Prompt Agent và Hosted Agent từ tài liệu, không suy đoán.
4. Review Tool catalog, Toolboxes, function calling, Code Interpreter, Web/File
   Search, Azure AI Search, OpenAPI, MCP, A2A, Browser Automation, Computer Use,
   SharePoint, Fabric và Work IQ: maturity, auth, execution path, limits và
   production suitability. Phân biệt Toolbox với MCP server.
5. Review Skills: maturity, format, `SKILL.md`, versioning, attach vào Agent và
   Toolbox, MCP exposure/resources, Prompt/Hosted usage và limitations.
6. Review external/custom MCP, Toolbox MCP compatibility, authentication,
   Agent Identity, OAuth/OBO, approvals, allowlist và governance; phân tích
   security implications của external MCP.
7. Review A2A version, incoming/outgoing, endpoint exposure, external calls,
   identity/auth, Toolbox và maturity; phân biệt Connected Agents, A2A,
   Workflow và agent-as-tool, kể cả recommendation đã thay đổi.
8. Review sequential/branching/group-chat/multi-agent/HITL/deterministic/agentic
   workflow; so với LangGraph, Agent Framework và custom TypeScript/Python;
   đánh giá khả năng thay custom workflow engine.
9. Phân biệt conversation state, session state, filesystem, Agent Memory,
   long-term memory và application DB. Review Memory Store, scope, retention,
   TTL, CRUD, cross-session và isolation.
10. Review File Search, Azure AI Search, Foundry IQ, SharePoint, Fabric IQ,
    custom RAG và MCP retrieval. Xác định PostgreSQL/pg_vector/Redis/Blob/MinIO
    có buộc migrate không và các đường giữ custom RAG.
11. Review OpenTelemetry, Application Insights, agent/tool traces, usage,
    latency/error, dashboards, replay, production/custom monitoring và khả năng
    gửi telemetry từ agent ngoài Foundry.
12. Phân biệt offline/cloud/agent/model/dataset/trace/conversation/continuous/
    recurring evaluation, custom/built-in evaluator, LLM judge và red teaming;
    review maturity, production suitability và CI/CD.
13. Review Agent Optimizer maturity, Prompt/Hosted support và phạm vi optimize:
    instructions, model, tool descriptions, skills.
14. Review Entra ID, Agent/Managed Identity, RBAC, secrets, per-user auth,
    OAuth OBO, VNet/BYO VNet/Private Endpoint, endpoint/outbound/data isolation,
    Content Safety, injection protection và auditability. Xác minh compute,
    Data Proxy, ACR/private-resource networking; không suy từ “có VNet”.
15. Review riêng scaling của Prompt/Hosted Agent: unit, sessions, sandbox,
    compute, CPU/RAM, concurrency, subnet/IP, limits, revisions, regions, quotas.
16. Review versioning/deployment qua azd, SDK, REST, container/ACR/env, immutable
    versions, rollback, blue-green, canary và traffic splitting.
17. Review cost drivers, không bịa giá: inference/tools/Azure dependencies cho
    Prompt Agent; thêm CPU/RAM/active-session/concurrency cho Hosted Agent.
18. Review lock-in của managed Prompt, Hosted và external custom runtime;
    portability của code/container/MCP/A2A/OTel/framework so với Agent Service,
    Toolboxes, managed Skills/Memory/Identity/runtime/evaluations.
19. Review migration của classic Foundry/Agents, Assistants API, Connected
    Agents và Hosted preview backend cũ; ghi ngày và requirement khi có.
20. So sánh A: managed Prompt Agents; B: custom code trên Hosted Agents; C:
    external custom runtime dùng chọn lọc Foundry. Chấm flexibility, operations,
    scale, security, observability, tools/skills/workflow, portability, lock-in,
    maturity, cost, migration và maintainability.
21. Kết luận riêng “Technically possible” và “Recommended for production”; trả
    lời 100% Foundry có còn custom code không, phần nào giao Foundry, phần nào giữ
    code, Preview risks, và chọn A/B/C.

## Phương pháp và bằng chứng cần review

22. Có nhiều vòng search/read/gap/counter-search/cross-check/verify/synthesize;
    capability hoặc limitation mới phải được điều tra tiếp.
23. Ưu tiên Microsoft Learn/docs/GitHub/architecture, official specifications,
    sau đó issue/discussion và community production experience. Search snippet
    không phải evidence; phải mở nguồn.
24. Kiểm tra freshness tháng 6–9/2026. Khi nguồn mâu thuẫn, xét update date,
    classic/new, maturity và API/version rồi tìm thêm nguồn; không âm thầm chọn.
25. Có evidence matrix cho Agent Service, Prompt/Hosted Agent, Toolbox, Skills,
    MCP, A2A, Workflow, Memory, Evaluation, Agent Optimizer, Observability và
    Private networking. Status chỉ được là GA, Preview, Deprecated, Retiring hoặc
    Unknown / insufficient evidence.
26. Mỗi claim ảnh hưởng recommendation có citation; thiếu evidence phải ghi
    “Chưa đủ bằng chứng để xác nhận”.
27. Counter-research phải tìm limitations/quotas/network/preview/deployment/
    lock-in/migration, rồi tìm chiều ngược lại: bằng chứng custom runtime có thể
    không còn cần.
28. Không dựa vào marketing, không suy maturity từ service cha, không trộn
    classic/current, Assistants/Responses, session/memory, tool/skill, MCP/A2A,
    workflow/agent; không nói scalable/private/enterprise-ready nếu thiếu cơ chế
    và limitation; không bịa giá hoặc chỉ tóm tắt từng trang.
29. Report cần Executive Summary; product/runtime architecture; Prompt/Hosted;
    Tools/Toolbox/MCP/A2A/Skills; Workflow; Memory/Knowledge; Observability/
    Evaluation; Security; Scaling/Deployment; maturity matrix; limitations;
    A/B/C; risk; recommendation; future changes; confidence và used sources.
30. Có Research Trace Summary không lộ chain-of-thought: query groups, opened/
    read và primary-source counts, early gaps, contradictions, unverifiable
    claims và areas where more research may change the result.

## Phân chia kiểm tra

- Automatic: prompt digest, live search/read receipts, domain diversity,
  provenance audit, usage completeness, stream/UI, broad topic markers, evidence
  matrix schema, architecture distinction và trace fields.
- Independent reviewer: factual accuracy, source-to-claim entailment, date/
  maturity correctness, contradiction resolution, omitted sub-capabilities,
  production judgment và chất lượng recommendation.
