# Tối ưu context

Các API tùy chọn này thuộc **0.1.5**, hiện chưa phát hành. Dùng typings
workspace hoặc package đóng gói cục bộ cho đến khi 0.1.5 có trên npm.
Compaction theo áp lực context và giới hạn output tool tức thời vẫn là hai cơ chế riêng.

## Đóng gói observation lặp lại

Tạo một controller và store riêng cho từng hội thoại. Trong ví dụ này, host
cung cấp backend archive, model, tool thông thường và application hooks:

```ts
import { createContextOptimizer } from '@alvin0/ai-agent-sdk-core/memory'
import { createMemorySpillStore } from '@alvin0/ai-agent-sdk-core/tools'

const optimizer = createContextOptimizer({
  store: createMemorySpillStore(),
  archive: async (snapshot, milestone, signal) => {
    await archiveStore.save(milestone.id, snapshot, signal)
  },
})
const agent = runtime.agent({
  id: 'research', model,
  instructions: 'Use read_tool_output when retained evidence is needed.',
  tools: [searchTool, optimizer.retrievalTool],
})
const session = agent.createSession({ hooks: optimizer.wrapHooks(applicationHooks) })
```

Phải gắn retrieval tool rõ ràng. `wrapHooks` giữ application hooks, redaction,
rejection, prepend và projection. Nó đổi model request, không sửa raw history
append-only hay checkpoint snapshot. Steering đang đợi được giao trước
compaction thông thường và projection hook.

| Mặc định | Ý nghĩa |
| --- | --- |
| Ngưỡng 10 KiB | Kích thước UTF-8 của observation, không phải số token |
| Hai request đầy đủ | Observation ban đầu được đưa đầy đủ vào request đã chuẩn bị |
| Preview khoảng 1 KiB | Request sau có thể dùng preview và locator để truy xuất |
| 64 observation / 128 milestone | Giới hạn sức chứa của controller |

Evidence bắt buộc của diagnostic/lỗi phải vừa preview; nếu không thì giữ text
đầy đủ. Store mất dữ liệu, reducer thất bại hoặc hết sức chứa cũng giữ bản đầy
đủ. Output budget độc lập có thể spill/truncate sớm hơn; hãy đặt đủ cho các
observation ban đầu cần giữ. Offset truy xuất tính theo Unicode code point.
Số request đã chuẩn bị tính cả retry/final request, không chỉ lần provider nhận
thành công. `metrics()` là ước tính, không phải bằng chứng billing.

## Lưu trữ milestone hoàn tất

Host xác minh hoàn tất và cung cấp boundary history bao gồm entry cuối:

```ts
const snapshot = session.snapshot()
optimizer.completeMilestone({
  id: 'inventory', throughSeq: snapshot.history.entries.at(-1)!.seq,
  summary: 'Inventory read; no files changed. Preserve ACL constraints.',
  remainingTurns: 4, compactionCost: 0,
})
```

Archive phải thành công trước khi projection được chấp nhận. Token tiết kiệm
ròng ước tính, tính cả summary và số lần tái sử dụng, phải đáng với chi phí
compaction. Đưa chi phí model/archive về đơn vị tương thích khi cần. Tool thành
công không tự chứng minh milestone hoàn tất. Redaction hoặc xóa message nguồn
sau đó sẽ làm summary dựa trên message ấy mất hiệu lực.

## Rút gọn evidence chính xác của log

Gắn `createModelEvidenceReducer({ generate })` làm `reducer` và cung cấp
callback `log(toolName, text)` của optimizer với `status` chuẩn và
`requiredLines`. Host chọn model extractor, tắt tool của nó, truyền tiếp signal,
đặt timeout và hạch toán usage riêng.

Log trên 4 KiB có thể đủ điều kiện. Evidence `{ line, text }` phải tăng dần,
giữ status host và khớp chính xác từng dòng nguồn. Core dựng lại evidence gốc
sau khi kiểm tra. Output sai format, thiếu evidence, đổi status/text, provider
lỗi, kết quả quá lớn hoặc không tiết kiệm sẽ dùng bản gốc đầy đủ. Format lạ cần
parser của host; rule diagnostic chung không chứng minh được mọi log đầy đủ
về ngữ nghĩa. `reduceEvidence` và `diagnosticLineNumbers` cũng hỗ trợ extractor
deterministic.

## Lifecycle hội thoại

Gọi `optimizer.dispose()` khi kết thúc hội thoại. Reset/resume cần controller
và store scope mới; state là tạm thời và có thể dựng lại từ raw history. Không
chia sẻ controller giữa hội thoại hoặc giữa preparation đồng thời. Dispose
hủy công việc có hỗ trợ signal; backend chịu trách nhiệm hoàn tất và dọn các write.

Xem [nâng cấp từ 0.1.4](/vi/01-introduction/upgrading-from-0-1-4),
[program tool](/vi/12-experimental/programmatic-tools) và
[hướng dẫn ứng dụng đầy đủ](https://github.com/alvin0/ai-agent-sdk/blob/main/docs/context-optimization.md)
để xem action fusion, ví dụ reducer và lệnh kiểm chứng.
