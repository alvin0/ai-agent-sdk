# Getting Started

Trước khi viết mã, hãy chọn tầng bạn muốn tự sở hữu. SDK được phân tầng có chủ
ý, và phần lớn bề mặt API chỉ trở nên hợp lý khi bạn biết mình đang đứng ở tầng
nào.

## Ba tầng API

| Tầng | Điểm vào | Bạn sở hữu | Dùng khi |
| --- | --- | --- | --- |
| **Gốc ghép nối** | `createAgentRuntime()` | Provider, observability, vòng đời | Gần như luôn luôn. Bắt đầu từ đây. |
| **Định nghĩa tái dùng** | `defineAgent()` + `createSession()` | Danh tính và chính sách agent, dạng giá trị ở phạm vi module | Cùng một agent phục vụ nhiều yêu cầu |
| **Vòng lặp thô** | `runAgent()`, `runTurn()`, `ModelRegistry.stream()` | Mọi ranh giới thực thi, tường minh | Bạn cố ý tự sở hữu lịch sử hoặc chính sách thực thi |

```text
createAgentRuntime()                    ← provider, observability, báo cáo đóng
    │
    runtime.agent({ … })                ← danh tính, chỉ dẫn, model, năng lực
        │
        createSession({ … })            ← một hội thoại: lịch sử, bộ nhớ, skill
            │
            run() / stream()            ← một lượt
                │
        runAgent({ mode, history })     ← bạn sở hữu lịch sử, SDK sở hữu chính sách thực thi
                │
        runTurn({ registry, tools })    ← bạn sở hữu mọi ranh giới thực thi
                │
        registry.stream(call)           ← bạn sở hữu toàn bộ vòng lặp
```

Chỉ đi xuống khi tầng phía trên không diễn đạt được điều bạn cần. Mọi tầng dưới
tầng đầu tiên đều buộc bạn tự lo lịch sử, các chặn trên, và việc huỷ.

## Bảy nguyên tắc thiết kế

Khi thấy điều gì đó trong SDK có vẻ lạ, thường một trong bảy quy tắc này là lý do.

**1. Adapter là tầng duy nhất biết định dạng wire.** Một provider cung cấp bốn
thứ — `connect`, `endpointPath`, `buildBody`, `translate` — và `stream()` nằm ở
lớp cơ sở, không nằm trong provider. Nhờ vậy provider không thể tự viết vòng lặp
fetch riêng rồi quên header quy kết, xử lý sai abort, hoặc bịa mã lỗi.

**2. Streaming là con đường duy nhất.** Không có lời gọi không-streaming riêng để
có thể trôi lệch. API một-phát như `agent.generate()` rút cạn đúng luồng mà API
trực tiếp dùng.

**3. Dữ liệu thiếu vẫn để thiếu.** Số token mà nhà cung cấp không báo sẽ là
`missing` hoặc `partial` — không bao giờ là số 0 bịa ra. Một ngân sách không đo
được sẽ nói rõ, thay vì lặng lẽ cho qua.

**4. Quyền riêng tư là mặc định, không phải tuỳ chọn bạn phải nhớ bật.** Quan sát
vận hành mặc định `content: 'none'`. Bộ ghi log wire chính xác là năng lực rủi ro
cao có cổng riêng: nó từ chối khởi tạo trừ khi đặt cả `content: 'full'` lẫn
`allowWireBodies: true`.

**5. Quyền sở hữu và vòng đời là tường minh.** Mọi năng lực khai báo ai là người
đóng nó. Không có gì bị tự động đóng hộ bạn, và không có gì bịa ra hành động đóng
cho tài nguyên nó chưa từng chiếm giữ.

**6. Tầng runtime được khai báo và kiểm tra.** Mỗi package khai báo `universal`,
`browser`, hoặc `node`. Một cổng kiểm tra tĩnh sẽ chặn khai báo Universal nào
import builtin Node, và chặn một hành trình Edge bị nâng tầng bởi năng lực Node.

**7. Chặn trên ở mọi nơi, khái niệm sản phẩm thì không nơi nào.** 16 bước model,
64 lượt điều phối tool, trần 500.000 token tổng đã báo cáo, và nhiều nữa — tất cả
cấu hình được bởi host, không cái nào là tenant hay gói cước.

## Hệ quả bạn phải làm

| Nguyên tắc | Hệ quả cho mã của bạn |
| --- | --- |
| Chỉ streaming | `await .result`, hoặc lặp qua run handle |
| Thiếu vẫn để thiếu | Kiểm tra độ phủ usage trước khi tính tiền dựa trên nó |
| Sở hữu tường minh | Đóng runtime, rồi đóng thứ bạn đã kết nối |
| Tầng được khai báo | Chọn package khớp với môi trường triển khai |
| Không có model mặc định | Luôn nêu rõ `model` |

## Cách đọc tài liệu này

| Tôi muốn… | Vào |
| --- | --- |
| Cài đặt và chạy được ngay hôm nay | [Cài đặt](/vi/01-introduction/installation), [Quick Start](/vi/01-introduction/quick-start) |
| Xây một agent | [Agents](/vi/02-agents/) |
| Cấp cho nó các hàm có kiểu | [Tools](/vi/03-tools/) |
| Cấp cho nó năng lực tiết lộ dần | [Skills](/vi/04-skills/) |
| Duy trì liên tục qua tác vụ dài | [Memory](/vi/05-memory/) |
| Điều phối nhiều bước hoặc nhiều agent | [Workflows](/vi/06-workflows/) |
| Dùng hoặc công bố tool MCP | [MCP](/vi/07-mcp/) |
| Nói chuyện với agent ở dịch vụ khác | [A2A](/vi/08-a2a/) |
| Trỏ SDK tới một endpoint | [Providers](/vi/09-providers/) |
| Đưa lên production | [Advanced](/vi/10-advanced/) |
| Hiểu phần nội bộ | [Internals](/vi/11-internals/) |
| Tra cứu một export chính xác | [Tham chiếu API](/vi/13-api-reference/) |
