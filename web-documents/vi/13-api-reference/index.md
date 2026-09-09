# Tham chiếu API — Tổng quan

Tham chiếu được biên soạn, mỗi họ package một trang. Mỗi trang liệt kê các điểm
vào công khai, những export quan trọng, và hình dạng cách dùng.

> **Quy tắc bề mặt công khai.** Root đã ghi tài liệu cộng với các subpath được
> liệt kê là công khai. Đường dẫn mã nguồn nội bộ **không** phải hợp đồng tương
> thích — import sâu vào nội bộ `dist/` hay `src/` sẽ vỡ mà không cần đổi major
> version.

## Các package

| Trang | Package bao gồm | Runtime |
| --- | --- | --- |
| [core](/vi/13-api-reference/core) | `@ai-agent-sdk/core` và 6 subpath của nó | Universal |
| [Agent](/vi/13-api-reference/agent) · [Tool](/vi/13-api-reference/tool) · [Workflow](/vi/13-api-reference/workflow) · [Memory](/vi/13-api-reference/memory) · [Types](/vi/13-api-reference/types) | Tham chiếu theo khái niệm | Universal |
| [Provider](/vi/09-providers/) | `provider-openai`, `provider-anthropic`, `provider-codex`, `provider-gemini`, `provider-http` | Universal |
| [Protocol](/vi/09-providers/protocols) | `protocol-responses`, `protocol-anthropic-messages`, `protocol-gemini-interactions` | Universal |
| [Observability](/vi/13-api-reference/observability) | `observability-fetch`, `-otel`, `-browser`, `-node` | hỗn hợp |
| [MCP](/vi/07-mcp/mcp-client) | `mcp`, `mcp-server`, `mcp-node`, `mcp-node-server` | hỗn hợp |
| [A2A](/vi/08-a2a/remote-agents) | `a2a` | Node |
| [auth-node](/vi/09-providers/auth-node) | `auth-node` | Node |
| [skill-filesystem](/vi/04-skills/loading-skills) | `skill-filesystem` | Node |
| [testkit](/vi/14-project/testkit) | `testkit` (chỉ dev) | Universal |

## Slot ghép nối nhìn nhanh

Mọi package ngoài core đều ghi rõ nó cắm vào đâu và ai đóng nó.

| Package | Slot ghép nối | Vòng đời |
| --- | --- | --- |
| `provider-openai` / `-anthropic` / `-codex` / `-gemini` | `runtime.providers` | `inert-runtime-owned-registration` |
| `provider-http` | `provider-author.adapter` | `inert-value` |
| `protocol-*` | `provider-author.protocol` | `inert-value` |
| `mcp`, `mcp-node` | `runtime-agent.toolSources` | `connected-caller-owned` |
| `mcp-server` | `host.mcp-server` | `inert-host-mounted` |
| `mcp-node-server` | `host.mcp-server` | `host-owned` |
| `a2a` | `runtime-team.linkAgent` | `borrowed-caller-owned` |
| `auth-node` | `provider-factory.credentials` | `borrowed-caller-owned` |
| `skill-filesystem` | `runtime-agent.skills` | `borrowed-caller-owned` |
| `observability-fetch` / `-node` / `-browser` | `runtime.observability.exporters` | `explicit-owned-or-borrowed` |
| `observability-otel` | `runtime.observability.openSpan-processors` | `borrowed-caller-owned` |

## Đọc nhãn vòng đời

| Nhãn | Nghĩa là |
| --- | --- |
| `inert-value` | Tạo ra nó không gây I/O và nó không có nghĩa vụ đóng. |
| `inert-runtime-owned-registration` | Runtime kích hoạt và gỡ bỏ đăng ký đã nắm bắt. |
| `connected-caller-owned` | Bạn kết nối thì bạn đóng — sau khi đã đóng runtime. |
| `borrowed-caller-owned` | Runtime dùng nó nhưng không bao giờ đóng nó. |
| `host-owned` | Bạn gọi `close()` và đọc báo cáo trả về. |
| `explicit-owned-or-borrowed` | Quyền sở hữu được nêu ngay lúc đăng ký. |
