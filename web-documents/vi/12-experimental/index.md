# Experimental

> **Không có gì trong SDK mang nhãn `@experimental`.** Không có export
> `experimental`, không có namespace bất ổn, và không có cờ bật để dùng hành vi
> tiền phát hành. Tìm trong mã nguồn `@experimental`, `@alpha`, hay `@unstable`
> đều không ra kết quả.
>
> Những phần *thực sự* còn tạm thời được liệt kê tường minh ở đây, kèm cổng kiểm
> tra mà mỗi phần đang chờ. Hãy coi trang này là câu trả lời trung thực cho câu
> hỏi "cái gì có thể đổi".

## 1. `@alvin0/ai-agent-sdk-a2a` được nâng lên tầng Node, đang chờ được thăng cấp

| Thuộc tính | Trạng thái |
| --- | --- |
| Tầng runtime khai báo | `node` |
| Lý do | Bộ mã hoá nhị phân ở thượng nguồn gọi `Buffer.from` để tuần tự hoá `Part` nhị phân thô |
| Chạy được hôm nay | Văn bản, dữ liệu có cấu trúc, URL, và giá trị nhị phân — trên Node |
| Phần tạm thời | Các đường văn bản tình cờ chạy được trong Worker nghiêm ngặt |
| Cổng kiểm tra | Một **cổng kiểm tra phủ định** đã cam kết phải thông qua mà không cần biến toàn cục của Node |

Cho tới khi cổng đó thông qua, package **không được quảng bá cho runtime
Edge/Worker**, dù một khối lượng công việc chỉ-văn-bản có thể trông như chạy được
ở đó.

**Cần làm gì:** hãy coi A2A là chỉ-Node khi lập kế hoạch triển khai. Nếu bạn cần
agent xuyên dịch vụ trên Edge, hãy đặt bước A2A phía sau một dịch vụ Node.

Root `.` cùng `./client` và `./server` vẫn là bí danh tương thích trên cùng một
hiện thực — phần bí danh đó là ổn định, không tạm thời.

## 2. Tầng truyền tải SSE legacy của MCP chỉ là đường di trú

| Thuộc tính | Trạng thái |
| --- | --- |
| Tầng truyền tải được ưu tiên | Streamable HTTP |
| Phần tạm thời | Phương án dự phòng SSE đã lỗi thời, thử **một lần** khi khởi động thất bại không do auth |
| Khả năng nhìn thấy | `state.protocol` phơi ra `era`, `version` chính xác, `transport`, và `fallback` |

```ts
createMcpHttpClient({ serverName: 'inventory', url, legacySse: false })
```

SSE tồn tại để với tới các server cũ. **Triển khai MCP mới nên dùng Streamable
HTTP**, và phương án dự phòng cố ý quan sát được để một triển khai legacy không
ẩn mình trong giao diện sức khoẻ.

**Cần làm gì:** hãy hiển thị `state.protocol` trong bề mặt sức khoẻ của bạn, và
đặt `legacySse: false` khi mọi server bạn nói chuyện đã di trú xong.

## 3. Package trên registry dùng scope `@alvin0`

| Thuộc tính | Trạng thái |
| --- | --- |
| Phiên bản | `0.1.1` |
| Publish npm | **Đã publish** dưới tên `@alvin0/ai-agent-sdk-*` |
| Quy trình release | CI theo tag với các gate package và provenance |

```bash
pnpm add ./artifacts/ai-agent-sdk-core-0.1.1.tgz
```

Mọi lệnh `pnpm add @alvin0/ai-agent-sdk-...` trong tài liệu này trỏ trực tiếp
tới package đã publish. Tarball cục bộ vẫn dùng được để kiểm chứng trước release.

`@alvin0/ai-agent-sdk-testkit` còn ở trạng thái **private** và được chạy qua cài đặt
workspace cục bộ hoặc tarball; việc publish cố ý không được cấu hình cho nó.

## 4. Ước lượng token là một chỗ giữ có chủ ý

SDK trung lập không thể đóng gói mọi tokenizer của nhà cung cấp, nên bộ đo mặc
định là một **bộ ước lượng tất định, thiên về an toàn**, tính trên văn bản, schema
tool, trạng thái phát lại, và chi phí ảnh cố định.

Giá trị ước lượng không bao giờ được trình bày như số do nhà cung cấp báo hay số
có thẩm quyền tính tiền. Ứng dụng cần tính giá chính xác có thể đặt
`maxInputTokens` tuyệt đối.

> Các tokenizer backend trong tương lai có thể thay bộ đo **mà không đổi hợp đồng
> lịch sử hay session**. Đó là bảo đảm về tính ổn định: bộ ước lượng có thể tốt
> lên, còn các bề mặt quanh nó thì không dịch chuyển.

## Phần nào *không* tạm thời

Đáng nêu rõ, vì đây là những phần người ta thường tưởng là bất ổn nhất:

- Các hợp đồng trung lập về message, stream, usage, và lỗi.
- `createAgentRuntime()`, `defineAgent()`, `defineTool()`, và API session.
- Các tầng runtime và cổng kiểm tra tĩnh cưỡng chế chúng.
- Đồ thị package trong `scripts/package-policy.mts`, được các cổng graph và
  runtime-boundary trong CI cưỡng chế ở mọi thay đổi.

## Đọc tiếp

- [A2A](/vi/08-a2a/) — ghi chú về việc nâng tầng Node, trong ngữ cảnh
- [Connecting Servers](/vi/07-mcp/connecting-servers) — thương lượng truyền tải
- [Thông tin dự án](/vi/14-project/) — đánh phiên bản và trạng thái phát hành
