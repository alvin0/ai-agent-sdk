# Giấy phép

AI Agent SDK được cấp phép theo **MIT License**.

Toàn văn nằm trong tệp `LICENSE` ở gốc repository, và một bản đi kèm mọi package
được phát hành.

```text
Copyright (c) 2026 alvin0 (chaulamdinhai) <chaulamdinhai@gmail.com>
```

## Điều đó nghĩa là gì trên thực tế

| Bạn được phép | Điều kiện |
| --- | --- |
| Dùng cho mục đích thương mại | — |
| Sửa đổi | — |
| Phân phối | Kèm thông báo bản quyền và toàn văn giấy phép |
| Cấp phép lại | Kèm thông báo bản quyền và toàn văn giấy phép |
| Dùng riêng tư | — |

Điều kiện **duy nhất** là thông báo bản quyền và thông báo cấp phép này phải xuất
hiện trong mọi bản sao hoặc phần đáng kể của Phần mềm.

Phần mềm được cung cấp **"nguyên trạng", không kèm bảo đảm nào**, và tác giả cùng
người giữ bản quyền không chịu trách nhiệm cho bất kỳ khiếu nại hay thiệt hại nào
phát sinh từ việc sử dụng.

MIT không cấp quyền sáng chế một cách tường minh và không cấp quyền nhãn hiệu đối
với tên hay logo của dự án.

## Giấy phép của bên thứ ba

Biểu thức SPDX của các phụ thuộc production được `pnpm check:supply-chain` đối
chiếu với danh sách cho phép trong thiết kế; lệnh này đồng thời cưỡng chế toàn
vẹn SHA-512 của lockfile, ghim chính xác phụ thuộc runtime, danh sách cho phép
script vòng đời đã rà soát, và một lượt `pnpm audit --prod` sạch.

Các phụ thuộc runtime trực tiếp đáng chú ý:

| Phụ thuộc | Package sở hữu |
| --- | --- |
| `eventsource-parser@4.1.0` | `@ai-agent-sdk/provider-http` (chủ sở hữu trực tiếp duy nhất) |
| `@modelcontextprotocol/*` | `@ai-agent-sdk/mcp`, `mcp-server`, `mcp-node`, `mcp-node-server` |
| `@a2a-js/sdk` | `@ai-agent-sdk/a2a` |
| `@opentelemetry/api`, `@opentelemetry/api-logs` | `@ai-agent-sdk/observability-otel` (peer) |

Xem [chính sách phụ thuộc](/vi/14-project/dependency-policy) để biết các ngoại
lệ đã rà soát và hạn rà soát lại của chúng.

## Đóng góp

Đóng góp được chấp nhận theo cùng các điều khoản MIT: mọi đóng góp được gửi có
chủ đích để đưa vào tác phẩm đều được cấp phép theo các điều khoản đó, không kèm
điều kiện bổ sung, trừ khi bạn nêu rõ khác đi.

## Đọc tiếp

- [Đóng góp](/vi/14-project/contributing)
- [Chính sách phụ thuộc](/vi/14-project/dependency-policy)
