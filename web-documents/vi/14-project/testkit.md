# `@alvin0/ai-agent-sdk-testkit`

Runtime: **Universal** — chỉ là phụ thuộc phát triển.

Bộ kiểm tra tuân thủ độc lập framework, chỉ dùng lúc phát triển, dành cho tác giả
các package năng lực.

> **Trạng thái.** Package hiện đang **private** và được chạy qua cài đặt workspace
> cục bộ hoặc tarball; việc publish cố ý không được cấu hình.
>
> ```bash
> pnpm add -D ./artifacts/ai-agent-sdk-testkit-0.1.0.tgz
> ```

## Export

```ts
export {
  runProviderConformanceSuite,
  ProviderConformanceError,
}

export type {
  ProviderConformanceCase,
  ProviderConformanceCaseInput,
  ProviderConformanceCheck,
  ProviderConformanceCheckId,
  ProviderConformanceControl,
  ProviderConformanceControlSnapshot,
  ProviderConformanceFixture,
  ProviderConformanceOptions,
  ProviderConformanceReport,
  ProviderConformanceScenario,
}
```

## Chạy bộ kiểm tra

```ts
import { runProviderConformanceSuite } from '@alvin0/ai-agent-sdk-testkit'

const report = await runProviderConformanceSuite(fixture)
```

Nó trả về một **báo cáo có cấu trúc đã đóng băng**, và ném
`ProviderConformanceError` mang chính báo cáo đó khi có kiểm tra nào thất bại —
nhờ vậy Vitest, `node:test`, hoặc bất kỳ harness nào khác dùng được mà không cần
phụ thuộc adapter.

## Nó kiểm tra gì

`runProviderConformanceSuite(fixture)` đưa một fixture provider mới đi qua:

| Mảng | Nội dung kiểm tra |
| --- | --- |
| Đăng ký | Kiểm tra marker, xung đột tuyến, rollback |
| Thực thi | Streaming, báo cáo usage, thử lại, huỷ |
| Danh mục | Hành vi khám phá và ảnh chụp |
| Thất bại | Thất bại luồng có chặn trên |
| Quan sát | Quyền riêng tư và tương quan |
| Dọn dẹp | Kiềm chế lỗi khi dọn dẹp, dọn dẹp lặp lại không đổi kết quả |

## Viết một fixture

Factory của fixture nhận **kịch bản, plugin ID, và tuyến**. Nó phải trả về:

- một `ComposableModelProviderPlugin` dạng trơ;
- model ID tường minh;
- các bộ đếm vòng đời;
- một rào chắn điều phối đang chạy dở cho kịch bản huỷ.

```ts
const fixture: ProviderConformanceFixture = ({ scenario, pluginId, route }) => ({
  plugin: myProviderPlugin({ /* … */ }),
  modelId: 'test-model',
  counters,
  barrier,
})
```

> **Tuyệt đối không** đưa thông tin xác thực, endpoint, hay lỗi thô của nhà cung
> cấp vào ảnh chụp điều khiển hay báo cáo.

## Đọc tiếp

- [Custom Provider](/vi/09-providers/custom-provider)
- [Kiểm thử và nghiệm thu](/vi/14-project/testing)
