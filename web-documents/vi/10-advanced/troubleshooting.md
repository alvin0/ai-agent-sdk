# Xử lý sự cố

Triệu chứng → nguyên nhân → cách sửa.

## Agent dừng sớm

**"Nó trả lời mà không dùng các tool tôi đã cấp."**

Kiểm tra `maxTurns` và `maxToolCalls`. Khi cạn ngân sách, hệ thống thường dành
sẵn một câu trả lời cuối đã tắt tool, nên ngân sách ngắn cho ra đúng hiện tượng
này. Hãy để ý cảnh báo ngân sách do app soạn, được chèn ở mốc **75% của
`maxToolCalls`**.

**"Nó dừng giữa chừng mà không có câu trả lời cuối."**

Cạn token thì dừng **ngay** — ngân sách an toàn không được tự tiêu vào việc giải
thích rằng nó đã cạn. Kiểm tra `maxTotalTokens` trong `runtimeLimits`.

**"Nó cứ gọi mãi một tool."**

Phát hiện lặp y hệt cảnh báo ở `repeatToolWarningAt` và dừng ở `repeatToolLimit`.
Phát hiện chu trình đa bước ngắn dùng `toolCycleWarningAt`, `toolCycleLimit`, và
`maxToolCycleLength`. Nếu model thực sự cần lặp lại, hãy nâng các mức này — nhưng
trước hết hãy kiểm tra xem kết quả tool của bạn có vô nghĩa không.

## Không có gì được nén

Nén theo áp lực tự động là **no-op** khi adapter không báo cửa sổ ngữ cảnh, trừ
khi có cấu hình `maxInputTokens`.

Nếu nó có chạy nhưng chẳng đạt được gì, hãy xem sự kiện `compaction-end`:

| `backoffReason` | Ý nghĩa |
| --- | --- |
| `unreachable-threshold` | Riêng phần đuôi giữ lại đã vượt ngưỡng. Hãy giảm `retainRatio`. |
| `low-savings` | Checkpoint tiết kiệm quá ít. Lịch sử của bạn phần lớn không nén được. |

Sau một trong hai trường hợp, nén theo áp lực lùi lại bốn bước model.
`session.compact()` thủ công và việc khôi phục khi nhà cung cấp xác nhận tràn vẫn
dùng được trong thời gian lùi đó.

## Số usage trông có vẻ sai

**"Số token đầu vào thấp hơn tôi tưởng."**

`inputTokens` **chỉ tính input không nằm trong cache**. Input bị tính tiền là:

```ts
usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
```

**"`totalTokens` bị thiếu."**

Nó chỉ được đặt khi có thẩm quyền — giữ nguyên từ tổng do nhà cung cấp báo, hoặc
suy ra từ các bộ đếm cộng dồn khớp nhau. Nó **bị bỏ trống chứ không đoán**.

**"Phép tính chi phí của tôi thấp quá."**

Kiểm tra `report.coverage`. `reported` là tổng cận dưới khi độ phủ chưa đầy đủ,
và `possiblyBilledAttemptsWithoutUsage` đếm số lượt đã gửi (hoặc có thể đã gửi)
mà không trả về bộ đếm. Đừng bao giờ gọi một tổng không có thẩm quyền là "tổng
chi phí".

## Huỷ không có tác dụng

**Báo cáo đóng có `unsettledRuns > 0`.**

Có thứ gì đó đã phớt lờ tín hiệu huỷ. Thủ phạm thường gặp là một tool khai báo
`timeoutMs` nhưng không chuyển tiếp `ctx.signal`. Khai báo `timeoutMs` là một
**lời hứa** rằng `execute` chuyển tiếp tín hiệu — đường ống sẽ abort rồi **chờ**;
nó không bỏ rơi promise, vì một tool mồ côi sẽ tiếp tục sửa trạng thái sau lưng
vòng lặp.

**`MODEL_TEARDOWN_TIMEOUT`.**

Một adapter đã phớt lờ tín hiệu huỷ và có thể vẫn giữ công việc sống. Đây là
khiếm khuyết của adapter, không phải một lỗi thoáng qua.

## Chọn provider thất bại

| Lỗi | Nguyên nhân |
| --- | --- |
| `NO_ADAPTER` | Không có provider nào đăng ký cho tuyến, hoặc `model.provider` viết sai. |
| `DUPLICATE_ADAPTER` | Hai plugin cùng giành một tuyến. Cho một cái id thực thể riêng, tường minh. |
| `UNSUPPORTED_*` | Model không khai báo năng lực đó. Kiểm tra `runtime.modelCatalog(route)`. |
| `OUTPUT_TOKEN_LIMIT_EXCEEDED` | `maxTokens` vượt trần cứng của model. |

Tất cả đều phát sinh **trước mọi I/O tới nhà cung cấp**, nên chúng không tốn chi
phí nào.

## Vấn đề với MCP

**"Các tool không bao giờ xuất hiện."**

Tool chỉ được công bố sau khi bắt tay **và** `tools/list` thành công. Kiểm tra
`connection.state.status` và `state.protocol`.

**"Chạy được nhưng server đang ở giao thức legacy."**

`state.protocol` phơi ra `era` đã thương lượng, `version` chính xác, `transport`
đã chọn, và có xảy ra `fallback` truyền tải hay không. Điều đó cố ý được hiển thị
để một triển khai legacy không ẩn mình trong giao diện sức khoẻ.

**"OAuth không hoàn tất."**

Hãy phân biệt bốn trạng thái trước khi viết giao diện:

| Trạng thái | Host cần làm |
| --- | --- |
| `authentication-required` | Chưa cấu hình nhà cung cấp thông tin xác thực nào được nhận diện. |
| `authentication-failed` | Đã cấp bearer/API token nhưng bị từ chối. |
| `oauth-authorization-required` | Hoàn tất redirect/callback rồi gọi `finishOAuth()`. |
| `scope-authorization-required` | Xin đồng ý cho `authorization.requiredScope`. |

Coi mọi mã `401` là OAuth là sai lầm kinh điển ở đây.

**"Một lần làm mới thất bại và tôi mất cả danh mục."**

Không mất — một lần làm mới thất bại vẫn giữ danh mục tốt gần nhất. Chỉ một ảnh
chụp đã lấy xong hoàn toàn mới được hoán đổi vào.

## Skill không nạp được

**"Model không bao giờ gọi `load_skill`."**

Việc khám phá chỉ đưa `id`, tên, mô tả, và ranh giới lựa chọn vào system prompt,
giới hạn bởi `maxCatalogChars` (mặc định 8.000). Nếu danh mục của bạn lớn, phần
mô tả có thể bị cắt. Hãy viết `whenToUse` thật dứt khoát.

**"Một id skill đã khai báo lại không khả dụng."**

Session thất bại **trước** khi gửi yêu cầu model, thay vì âm thầm chạy với một
năng lực khác. Hãy kiểm tra provider có thực sự liệt kê id đó không.

**"Tôi sửa `SKILL.md` mà không thấy tác dụng."**

Sửa ở cùng đường dẫn sẽ đổi revision nông của tệp và làm mất hiệu lực manifest
tài nguyên cũ, nên skill phải được nạp lại. Phần chỉ dẫn đã chọn trước đó vẫn nằm
trong lịch sử cho tới khi nén.

## Khôi phục thất bại

| Tình huống | Hành vi |
| --- | --- |
| Id agent khác | Thất bại sớm. |
| Provider/nguồn/vị trí tài nguyên skill đã trôi lệch | Thất bại trước khi gửi yêu cầu model. |
| Snapshot v1 cũ không có trạng thái skill | Hợp lệ — được chấp nhận. |
| Trường lạ | Bị loại bỏ. |

Phần thân và tài nguyên của skill không bao giờ được lưu. Khi khôi phục, hệ thống
khám phá lại và nạp lại từ các provider **hiện tại**.

## Thiếu telemetry

**"Sự kiện không tới backend của tôi."**

Kiểm tra `boundary` trong phần đăng ký. Một exporter khai `none` là không hề
tuyên bố có giao nhận. Giao nhận trong bộ nhớ **không bao giờ** tuyên bố tính bền
vững.

**"Sự kiện biến mất trong Edge worker."**

Host Edge không thể trông cậy vào việc tiến trình thoát. Hãy đưa promise flush
cho `waitUntil` tường minh của nền tảng:

```ts
flushObservabilityWithWaitUntil(observability, ctx.waitUntil)
```

**"Sự kiện trên trình duyệt biến mất khi đóng tab."**

`installBrowserObservabilityLifecycle()` flush khi trang ẩn và khi `pagehide`, và
**không tuyên bố bền vững lúc unload**. Sự kiện đã lưu vẫn chưa xác nhận cho tới
khi bạn gọi `acknowledgeBatch()` — hãy khôi phục chúng bằng `recoverEvents()` ở
lần tải sau.

**"Tôi bật cầu nối OTel nhưng không có gì được xuất ra."**

Cầu nối **không phải exporter**. Nó không cài nhà cung cấp toàn cục và không sở
hữu exporter OTLP. Hãy cấu hình SDK OpenTelemetry của bạn, hoặc thêm một sổ /
exporter có xác nhận.

## Vấn đề khi đóng gói

**"Bundle Edge của tôi kéo theo `node:fs`."**

Một package tầng Node đã lọt vào đồ thị. Các package tầng Node là `auth-node`,
`mcp-node`, `mcp-node-server`, `skill-filesystem`, `observability-node`, và
`a2a`.

**"Import sâu bị vỡ sau khi nâng cấp."**

Chỉ root đã ghi tài liệu cộng các subpath được liệt kê là công khai. Đường dẫn mã
nguồn nội bộ không phải hợp đồng tương thích.

## Đọc tiếp

- [Error Handling](/vi/10-advanced/error-handling) — hệ phân loại đầy đủ
- [Performance](/vi/10-advanced/performance) — mọi chặn trên và ngân sách
