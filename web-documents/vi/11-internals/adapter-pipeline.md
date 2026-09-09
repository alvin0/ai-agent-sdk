# Đường ống adapter

## Cách chia

Một provider cung cấp **bốn thứ**. Lớp cơ sở sở hữu mọi thứ còn lại.

| Provider cung cấp | Lớp cơ sở sở hữu |
| --- | --- |
| `connect` — thông tin xác thực, header, đặc điểm endpoint | `stream()` — toàn bộ vòng lặp fetch/SSE |
| `endpointPath` — yêu cầu đi tới đâu | Header quy kết |
| `buildBody` — lời gọi trung lập → thân wire | Xử lý abort và tháo dỡ |
| `translate` — sự kiện wire → chunk trung lập | Gán mã lỗi |

`stream()` nằm ở lớp cơ sở là **có chủ ý**. Một provider tự sở hữu vòng lặp fetch
của mình có thể quên header quy kết, xử lý sai abort, hoặc bịa mã lỗi — và mỗi
kiểu hỏng đó đều vô hình cho tới khi lên production.

## Đường đi đầy đủ của một lời gọi

```text
agent.generate(input)
    │
    ▼
runAgent / runTurn                 chính sách vòng lặp, chặn trên, lập lịch tool
    │
    ▼
ModelRegistry.prepareCall()        ảnh chụp năng lực, giá trị mặc định, kiểm tra
    │                              → chặn UNSUPPORTED_* trước mọi I/O
    ▼
withRetry (decorator)              chỉ trước khi chunk đầu tiên tới bên tiêu thụ
    │
    ▼
HttpModelAdapter.stream()          lớp cơ sở: fetch, SSE, chặn trên, abort, lỗi
    │
    ├── connect()                  provider: thông tin xác thực + header
    ├── endpointPath()             provider: đường dẫn URL
    ├── buildBody()                provider/giao thức: trung lập → wire
    │
    ▼
Endpoint HTTP của nhà cung cấp
    │
    ▼
Phân tích SSE                      media-type, chặn trên byte/chunk/sự kiện, heartbeat
    │
    ▼
translate()                        provider/giao thức: sự kiện wire → StreamChunk[]
    │
    ▼
Luồng StreamChunk                  block-start … usage … finish
    │
    ▼
BlockAssembler                     → Message + TokenUsage + FinishReason
```

## Registry làm gì trước khi gửi

`prepareCall()` trả về một ảnh chụp năng lực model **gắn theo thế hệ**: cửa sổ
ngữ cảnh tổng hợp, giới hạn output mặc định và cứng, các mức nỗ lực suy luận, các
phương thức vào/ra, và hỗ trợ native tool tường minh.

Trước bất kỳ I/O nào tới nhà cung cấp, nó:

- hiện thực hoá các giá trị mặc định của model;
- từ chối mức nỗ lực suy luận không hỗ trợ → `UNSUPPORTED_REASONING_EFFORT`;
- từ chối native tool không hỗ trợ → `UNSUPPORTED_NATIVE_TOOL`;
- từ chối output vượt trần cứng → `OUTPUT_TOKEN_LIMIT_EXCEEDED`;
- **chỉ** chiếu bỏ ảnh đầu vào với những model khai báo rõ là không có thị giác;
- ngăn phần dự trữ output nuốt trọn cửa sổ tổng hợp.

Một prepared call gắn theo thế hệ: sửa nó hoặc dùng lại qua các thế hệ sẽ thất
bại với `INVALID_PREPARED_CALL`.

## Quy tắc tuần tự hoá

- **Đồng bộ và chỉ dùng đối tượng JSON.**
- Kiểm tra và tách rời trước khi gửi, có chặn trên.
- **Một thân yêu cầu đã mã hoá được dùng lại qua các lần thử lại** — một lần thử
  lại không được tuần tự hoá lại một đối tượng đã bị sửa.

## Quy tắc phân tích SSE

Cục bộ theo provider và ghim chính xác:

| Quy tắc | Mục đích |
| --- | --- |
| Kiểm tra media-type | Chặn một trang HTML báo lỗi giả dạng luồng. |
| Chặn trên byte / chunk / sự kiện | Một luồng mất kiểm soát không thể vét cạn bộ nhớ. |
| Nhịp sống bằng comment-heartbeat | Một kết nối im lặng nhưng còn sống không bị coi là timeout. |
| Rút cạn tuyến tính | Không quét lại bộ đệm theo độ phức tạp bình phương. |
| Bắt buộc đúng một sự kiện kết thúc | Thân bị cắt cụt sinh `STREAM_CLOSED`, không phải một message ngắn âm thầm. |

`@ai-agent-sdk/provider-http` là chủ sở hữu trực tiếp duy nhất của bản ghim chính
xác `eventsource-parser@4.1.0`; xem
[chính sách phụ thuộc](/vi/14-project/dependency-policy).

## Gán lỗi

Adapter gán một `code` ổn định **tại ranh giới wire**. Sau đó **chính sách** thử
lại quyết định mã nào đủ điều kiện — không bao giờ do adapter đã gán mã đó quyết.

Adapter có thể ném lỗi, nhưng registry chuẩn hoá thành một `finish` kết thúc dạng
`error` hoặc `aborted` trước khi bên tiêu thụ nhìn thấy. Một luồng thất bại vẫn
phải **kết thúc**.

## Vị trí của thử lại

Thử lại là một decorator bọc quanh adapter, và nó chỉ thử lại những thất bại xảy
ra **trước khi chunk đầu tiên tới tay bên tiêu thụ**. Phát lại token đã giao sẽ
nhân đôi output.

```ts
registry.registerAdapter(['openai'], withRetry(openAiAdapter({ apiKey }), {
  policy: { mode: 'normal', maxRetries: 3 },
}))
```

`mode: 'always'` chỉ được chấp nhận khi yêu cầu có mang `AbortSignal`. Lượt agent
thông thường cung cấp sẵn qua deadline model.

## Lượt thử vật lý và lời gọi logic

Một lời gọi model **logic** có thể gồm nhiều lượt thử **vật lý** tới nhà cung
cấp. Mô hình quan sát giữ chúng tách bạch:

- `modelCallId` — một thao tác logic, bao gồm cả các lần thử lại tự động
- `attemptId` — một lượt thử vật lý

Mỗi lượt thử ghi `dispatchState: 'not-sent' | 'sent' | 'unknown'`. Một lượt bị
gián đoạn ở trạng thái `sent` hoặc `unknown` mà không trả về usage sẽ làm tăng
`possiblyBilledAttemptsWithoutUsage` — câu trả lời trung thực khi không thể biết
chính xác việc tính tiền từ phản hồi.

## Khi nào kế thừa lớp

Chỉ kế thừa `HttpModelAdapter` khi các sự kiện về kết nối **không thể biểu diễn
bằng dữ liệu** — ví dụ ký yêu cầu trên phần thân, như AWS SigV4.

Với provider hoàn toàn không dùng HTTP, bề mặt tác giả `ModelAdapter` trực tiếp
vẫn công khai, kèm handle registrar theo phạm vi kích hoạt và middleware,
metadata model, hạch toán, và dọn dẹp.

## Đọc tiếp

- [Thêm provider mới](/vi/09-providers/custom-provider)
- [Provider và registry](/vi/09-providers/)
