# Kiểm thử và nghiệm thu

Các bộ test được tách theo **chi phí** và **điều chúng chứng minh**.

## Các bộ test

| Lệnh | Bao phủ |
| --- | --- |
| `pnpm test:unit` | Bộ unit ở root. Nhanh, không mạng. |
| `pnpm test:contract` | Hợp đồng tương thích và danh tính runtime đã đóng băng. |
| `pnpm test:packages` | Mọi bộ test do từng package sở hữu. |
| `pnpm test:pack` | publint, ATTW, và toàn bộ fixture tarball/runtime. |
| `pnpm test:integration` | **Gọi provider thật.** Cần thông tin xác thực và tốn token. |

Test tích hợp là một lượt chạy riêng vì chúng tốn token và chậm tới mức trộn
chung sẽ làm người ta ngại chạy bộ test nhanh.

## Ma trận runtime

| Lệnh | Runtime |
| --- | --- |
| `pnpm test:edge` | Bản đóng gói của core, provider-http, mcp, observability-otel, cộng kiểm tra no-follow đa nền tảng |
| `pnpm test:browser` | Bản đóng gói của `observability-browser` |
| `pnpm test:node` | Bản đóng gói của `auth-node`, `mcp-node`, `mcp-node-server`, `skill-filesystem`, `observability-node` |
| `pnpm test:recovery` | Các đường khôi phục của observability |

## Cổng kiểm tra tĩnh

| Lệnh | Kiểm tra |
| --- | --- |
| `pnpm lint` | Đồ thị package, dependency-cruiser, ranh giới agent, ranh giới runtime |
| `pnpm check:boundary-fixtures` | Chứng minh các ranh giới không hợp lệ thực sự **bị chặn** |
| `pnpm check:supply-chain` | Toàn vẹn lockfile, ghim phiên bản chính xác, script vòng đời, giấy phép, `pnpm audit --prod` |
| `pnpm check:core-capability-contract` | Cổng biên dịch của design contract |
| `pnpm check:runtime-dependencies` | Báo cáo phụ thuộc runtime đối chiếu topology |
| `pnpm check:docs` | Sổ cái di trú tài liệu |
| `pnpm workspace:typecheck` | Kiểm tra kiểu mọi package sẽ phát hành, theo thứ tự đồ thị |
| `pnpm workspace:build` | Build mọi bundle và khai báo do package sở hữu |

`check:boundary-fixtures` quan trọng hơn vẻ ngoài của nó: một cổng không bao giờ
thất bại thì không khác gì không có cổng, nên bộ test khẳng định rằng đầu vào
không hợp lệ đúng là bị chặn.

## CI chạy gì

```text
pnpm workspace:build && pnpm workspace:typecheck && pnpm build:cli
  && pnpm lint && pnpm exec tsc --noEmit
pnpm check:boundary-fixtures
pnpm check:supply-chain
pnpm test
pnpm test:packages
pnpm test:pack
```

Node 22.12.0, pnpm 11.25.0 cài với script vòng đời bị tắt, lockfile đóng băng, và
các GitHub action chính thức ghim vào commit phát hành bất biến, có ký.

## Conformance cho provider

Với tác giả các package năng lực, `@ai-agent-sdk/testkit` đưa một fixture provider
mới đi qua kiểm tra marker, xung đột tuyến, rollback, streaming, usage, thử lại,
huỷ, hành vi danh mục, thất bại luồng có chặn trên, quyền riêng tư/tương quan của
quan sát, kiềm chế lỗi khi dọn dẹp, và dọn dẹp lặp lại không đổi kết quả.

```ts
import { runProviderConformanceSuite } from '@ai-agent-sdk/testkit'

const report = await runProviderConformanceSuite(fixture)
```

Nó độc lập framework: Vitest, `node:test`, hay harness của riêng bạn đều có thể
tiêu thụ báo cáo đã đóng băng hoặc bắt `ProviderConformanceError`.

## Nghiệm thu thủ công

Có những thứ không thể chứng minh một cách tất định. Repository có sẵn các harness
tương tác để nghiệm thu thủ công với provider thật:

```bash
npm run human            # menu
npm run human:basic      # chế độ basic
npm run human:deep       # chế độ deep với bài tự kiểm submit_result
npm run human:hil        # deep-human-in-loop
npm run human:web        # web search native
npm run human:vision     # ảnh đầu vào
npm run human:image-gen  # sinh ảnh
npm run human:mcp        # khứ hồi giao thức MCP không cần thông tin xác thực
npm run human:a2a-managed
npm run human:a2a-defined
```

`npm run human:mcp` đáng nhắc riêng: nó thực hiện initialize, khám phá, và gọi
tool thật qua các tầng truyền tải MCP nối với nhau, **không cần thông tin xác
thực của nhà cung cấp**, và in ra các trạng thái vòng đời, tên đã khám phá, cùng
kết quả khứ hồi có cấu trúc.

Các harness stress A2A dựng một website chạy được với nhiều agent đồng thời, mỗi
agent nhận một danh sách cho phép ghi chính xác. Các cổng kiểm tra dạng npm mà
model yêu cầu được dịch thành lời gọi cố định theo mô hình quyền của Node với môi
trường tối thiểu; script của package, mạng, tiến trình con, và truy cập ngoài
không gian làm việc dùng-một-lần đều bị từ chối. Đầu vào fixture/build do host sở
hữu được kiểm tra hash sau khi chạy.

## Quy tắc bằng chứng tất định

Topology đóng băng cách sinh ra bằng chứng, để một lượt chạy đi qua luôn mang
cùng một ý nghĩa:

- kiểm tra quyền riêng tư dùng **sự vắng mặt về cấu trúc hoặc giá trị canh không
  phải ID**, không dùng so khớp chuỗi;
- va chạm ID ngẫu nhiên vẫn được **ghi lại** kể cả khi một lượt chạy lại tập
  trung đã chẩn đoán ra chúng;
- bằng chứng về provider thật và mạng là **thủ công**, không bao giờ được một bộ
  test tất định khẳng định.

Các lượt biên dịch kép từ cùng nguồn bao phủ message/provider của core và mọi
miền agent — tool, skill, memory/history/compaction, accounting/trace,
loop/definition, và team/messaging — cả hai package giao thức, cả sáu điểm vào
năng lực observability, và ánh xạ tuyến MCP client/server. Sổ cái tương đương
bằng không cho core, agent, observability cơ sở, các giao thức, các năng lực
observability, và MCP.

> Chỉ có mặt cái tên là không đủ. Các fixture nguồn kép và việc tách bạch tường
> minh giữa giao thức legacy và runtime mới bảo vệ được những ngữ nghĩa nhạy cảm
> với tương thích.

## Đi qua thì chứng minh được gì

| Cổng | Chứng minh | Không chứng minh |
| --- | --- | --- |
| `check:core-capability-contract` | Ghép nối lúc biên dịch | Hành vi runtime, bản đồ export lúc đóng gói, mức sẵn sàng phát hành |
| `test:unit` / `test:contract` | Logic tất định và các hợp đồng đã đóng băng | Hành vi của provider thật |
| `test:pack` | Tarball đã đóng gói cài và chạy được theo từng tầng runtime | Hành vi của provider thật |
| `test:integration` | Lời gọi provider thật hoạt động | Không nói gì về tài khoản khác hay phiên bản model khác |
| Harness thủ công | Hành vi đầu-cuối thật mà một con người đã quan sát | Bất cứ thứ gì máy có thể tự kiểm chứng lại |

## Đọc tiếp

- [Design contract](/vi/11-internals/design-contracts)
- [`@ai-agent-sdk/testkit`](/vi/14-project/testkit)
- [Đóng góp](/vi/14-project/contributing)
