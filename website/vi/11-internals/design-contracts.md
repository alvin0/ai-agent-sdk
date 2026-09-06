# Design contract

`design-contracts/core-capability-v1/` là một **hiện vật thiết kế, không phải mã
hiện thực của package**. Nó trả lời một câu hỏi trước khi dời mã nguồn: các tên
package được khuyến nghị và hình dạng TypeScript công khai có đỡ nổi các hành
trình người dùng dự kiến hay không, với đúng những câu import mà người dùng sẽ
thật sự viết?

Không sinh ra JavaScript nào. Không chạy provider, mạng, cài đặt package, hay
fixture runtime nào.

## Trong đó có gì

| Loại | Tệp |
| --- | --- |
| Stub khai báo + fixture người dùng | `consumers/*.ts` — 25 hành trình biên dịch |
| Cấu hình biên dịch nghiêm ngặt | `tsconfig.declarations-*.json`, `tsconfig.current-*.json` |
| Sổ cái API đã đóng băng | `api-migration.json`, `implementation-api-I*.json`, `retained-package-api-baseline.json`, `provider-api-baseline.json` |
| Topology và manifest | `topology.json`, `manifest-blueprints.json`, `install-closures.json` |
| Trạng thái di trú | `source-migration.json`, `documentation-migration.json` |
| Quyết định đã phê duyệt | `phase0-decisions.json` |

## Chạy cổng kiểm tra

```bash
pnpm check:core-capability-contract
```

## Các hành trình

Fixture người dùng bao phủ Edge tối thiểu, Edge mở rộng, Node tối thiểu, tiện ích
thông tin xác thực từ môi trường trên Node, và harness Node đầy đủ — cộng với các
hành trình dành cho tác giả:

- một **provider Universal bên thứ ba** ghép qua các hợp đồng core, truyền tải, và
  giao thức công khai, không cần container plugin chung chung;
- một **tác giả chỉ dùng core** kế thừa trực tiếp hợp đồng adapter nâng cao cho
  provider không dùng HTTP, gồm luồng, metadata model, hạch toán, middleware, và
  dọn dẹp;
- **hai tài khoản cùng một họ provider** ghép qua ID và tuyến thực thể riêng biệt;
- các tác giả chỉ dùng core hiện thực nguồn/kho thông tin xác thực Universal,
  skill-provider, memory-store lạc quan, observation-exporter, và các họ
  tool-source sống.

Các khai báo cố ý **không** import package `agent` hay `observability` hiện tại,
và fixture người dùng không nhận một runtime factory được tiêm vào.

## Ba cấu hình khai báo nghiêm ngặt

| Cấu hình | Phạm vi |
| --- | --- |
| `tsconfig.declarations-node.json` | Toàn bộ khai báo đích và người dùng; `skipLibCheck: false`; phân giải NodeNext; kiểu Node tường minh |
| `tsconfig.declarations-web-base.json` | Mười package không phải Node trừ MCP client/server, cộng tám fixture tác giả; `types: []` |
| `tsconfig.declarations-web-full.json` | Cả mười hai package Universal/Browser, kể cả MCP |

Cả ba đều là kiểm tra cục bộ, chỉ biên dịch. **Không cái nào thay thế được nghiệm
thu runtime trên bản đã đóng gói.**

> Cấu hình `web-full` đi qua mà không cần kiểu Node ambient, shim, baseline chẩn
> đoán, hay miễn trừ `skipLibCheck`: phần phụ thuộc `Buffer` từ thượng nguồn
> trước đây đã được cô lập bằng các khai báo đa nền tảng do SDK sở hữu. Mã runtime
> vẫn dùng MCP 2.0.0, trong khi các khai báo SDK phát ra không còn nhắc tới
> `ReadBuffer.append(chunk: Buffer)` mà nó export ở root.

## Các sổ cái API

**`api-migration.json`** đóng băng 417 lượt xuất hiện của export công khai hiện
tại cùng hash khai báo sinh ra — 415 export ở root cộng hai export chỉ có qua
`@ai-agent-sdk/agent/skill-validation`.

> Khai báo theo hành trình cố ý hẹp và **không thể cho phép xoá một ký hiệu không
> được nhắc tới**. Giữ nguyên là mặc định; mọi lần xoá đều cần một quyết định đã
> phê duyệt cộng với lộ trình di trú cho người dùng.

**`implementation-api-I1.json` / `-I2.json`** là ảnh chụp theo giai đoạn của tập
khai báo phát ra. Trong lúc một giai đoạn còn là hiện hành, bộ kiểm tra so sánh
tập đó từng byte; sau khi `currentImplementationSlice` tiến lên, nó coi bản ghi
là lịch sử, kiểm tra cấu trúc và các tuyến, rồi áp các kiểm tra baseline và tương
đương vét cạn lên các khai báo chuẩn hiện tại.

Sự phân biệt đó quan trọng: nó ngăn một ảnh chụp giai đoạn lịch sử cấm các khai
báo bổ sung đã được rà soát ở lát cắt sau.

**`retained-package-api-baseline.json`** đóng băng 19 điểm vào công khai, hash
khai báo của chúng, và 344 lượt xuất hiện export cho A2A, auth, MCP, skill từ hệ
tệp, giao thức wire, và observation exporter. Khoảng trống rỗng chính xác được
khoá bằng hash, để trôi lệch về sau không thể âm thầm mở lại vấn đề tương đương.
Nó cũng thống kê riêng cả 53 lượt xuất hiện export được dời đi có chủ ý.

**`provider-api-baseline.json`** giữ danh mục 84 ký hiệu gốc làm bằng chứng lịch
sử. Các khai báo provider hiện tại phải chứa đúng baseline đó **cộng** các bổ
sung đã nêu tên và đã rà soát — bộ kiểm tra chặn cả ký hiệu cũ bị thiếu lẫn bổ
sung chưa khai báo.

## Bộ kiểm tra chặn những gì

| Vi phạm |
| --- |
| Khai báo Universal import package hoặc builtin của Node |
| Hành trình Edge bị nâng tầng bởi năng lực Node |
| Import facade chưa khai báo hoặc bị cấm |
| Trôi lệch giữa ánh xạ package trong `tsconfig` và topology |
| Lựa chọn package trực tiếp không còn khớp công thức đã ghi tài liệu |
| Hash khai báo gốc/hiện tại bị đổi |
| Có tệp khai báo đi kèm dư thừa hoặc trạng thái nguồn cũ |
| Hiện thực bị chép, root không đầy đủ, core công khai tự import chính nó, vòng lặp phụ thuộc |
| Bất cứ thứ gì vượt quá cầu tương thích đủ tuyến chính xác ở chủ sở hữu cũ |
| Khôi phục lại bài test runtime-spike đã lỗi thời và đã bị gỡ |

## Root công khai

Root công khai là một **facade chỉ re-export đã biên soạn**, với đúng 264 tên:
toàn bộ 184 export ở core-root hiện tại cộng 80 bổ sung ghép nối thường ngày đã
được rà soát.

Các subpath tập trung của core và root công khai là **khung nhìn lên cùng một chủ
sở hữu hiện thực chuẩn nội bộ**. Chúng không bao giờ sở hữu bản sao của lớp,
interface, registry, bus, hay trạng thái singleton. Kiểm tra va chạm so sánh
chính ràng buộc khai báo dùng chung mà cả hai điểm vào core cùng import; các test
phủ định chặn khai báo bị chép và các import trùng tên từ hai chủ sở hữu khác
nhau.

## Quyết định Phase 0

Mười bốn ID quyết định đã chuẩn hoá nằm trong `phase0-decisions.json` và được rà
soát trong `docs/core-capability-phase0-approval.md`. Bản ghi ở trạng thái
`approved`, sau phê duyệt tường minh của chủ sở hữu và bản sửa đổi về model mặc
định theo từng agent.

Bộ kiểm tra chặn ID thiếu, phê duyệt không kèm quy kết chủ sở hữu/thời gian, trôi
lệch về package đích/định danh/số lượng export ở root, trôi lệch ngân sách chẩn
đoán, và trôi lệch ID giữa Markdown và JSON.

## Đi qua cổng chứng minh và không chứng minh điều gì

**Chứng minh:** phép ghép nối lúc biên dịch. Các tên package được khuyến nghị và
hình dạng công khai đỡ được các hành trình người dùng dự kiến.

**Không chứng minh:** rằng các package tương lai sẽ export đúng những khai báo
này, rằng tập đóng gói của chúng tuân thủ tầng runtime, hay rằng việc chạy trên
Edge/Node hoạt động. Đó là các cổng nghiệm thu sau di trú — biên dịch từ tarball
đã cài cộng với các bài test đã đóng gói trên Node/Chromium/Workerd.

Phê duyệt cho phép dời mã nguồn theo từng giai đoạn. Riêng việc hợp đồng tĩnh đi
qua **không** phải là nghiệm thu runtime hay nghiệm thu phát hành.

## Đọc tiếp

- [Topology package](/vi/11-internals/package-topology)
- [Kiểm thử và nghiệm thu](/vi/14-project/testing)
