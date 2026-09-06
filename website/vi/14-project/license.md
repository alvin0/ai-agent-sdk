# Giấy phép

AI Agent SDK được cấp phép theo **Apache License, Version 2.0**.

Toàn văn nằm trong tệp `LICENSE` ở gốc repository, và tại
<https://www.apache.org/licenses/LICENSE-2.0>.

## Điều đó nghĩa là gì trên thực tế

| Bạn được phép | Điều kiện |
| --- | --- |
| Dùng cho mục đích thương mại | — |
| Sửa đổi | Nêu rõ các thay đổi đáng kể |
| Phân phối | Kèm theo giấy phép và tệp `NOTICE` nếu có |
| Cấp phép lại | — |
| Dùng riêng tư | — |
| Dùng phần cấp quyền sáng chế của người đóng góp | Quyền này chấm dứt nếu bạn khởi kiện sáng chế liên quan tới tác phẩm |

Bạn phải giữ lại các thông báo về bản quyền, sáng chế, nhãn hiệu, và quy kết có
trong mã nguồn.

Phần mềm được cung cấp **"nguyên trạng", không kèm bảo đảm hay điều kiện nào**,
và người đóng góp không chịu trách nhiệm cho thiệt hại phát sinh từ việc sử dụng.

Apache-2.0 **không** cấp quyền nhãn hiệu đối với tên hay logo của dự án.

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

Đóng góp được chấp nhận theo cùng các điều khoản Apache-2.0, theo mục 5 của giấy
phép: mọi đóng góp được gửi có chủ đích để đưa vào tác phẩm đều được cấp phép
theo các điều khoản đó, không kèm điều kiện bổ sung, trừ khi bạn nêu rõ khác đi.

## Đọc tiếp

- [Đóng góp](/vi/14-project/contributing)
- [Chính sách phụ thuộc](/vi/14-project/dependency-policy)
