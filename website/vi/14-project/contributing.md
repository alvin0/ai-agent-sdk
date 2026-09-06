# Đóng góp

## Thiết lập

```bash
pnpm install --frozen-lockfile
pnpm workspace:build
pnpm build:cli
```

Phát triển workspace cần Node **22.18** trở lên và pnpm **11.25.0**.
Các package năng lực Node đã publish vẫn giữ runtime tối thiểu là Node **22.12**.

## Trước khi push

```bash
pnpm workspace:build
pnpm workspace:typecheck
pnpm build:cli
pnpm lint
pnpm exec tsc --noEmit
pnpm check:boundary-fixtures
pnpm check:supply-chain
pnpm test
pnpm test:packages
pnpm test:pack
```

Đó đúng là những gì CI chạy. Chạy trước ở máy rẻ hơn nhiều so với một pipeline đỏ.

## Các quy tắc mà một thay đổi phải tôn trọng

**Tầng runtime.** Một package Universal không được import package hay builtin của
Node. Một hành trình Edge không được nâng tầng bởi năng lực Node. Cổng kiểm tra
tĩnh chặn cả hai.

**Bề mặt công khai.** Giữ nguyên là mặc định. Khai báo theo hành trình không thể
cho phép xoá một ký hiệu không được nhắc tới — mọi lần xoá đều cần một quyết định
đã phê duyệt cộng với lộ trình di trú cho người dùng.

**Adapter là tầng duy nhất biết định dạng wire.** Nếu một thay đổi dạy cho tầng
phía trên adapter về hình dạng wire của một nhà cung cấp, đó là thay đổi sai.

**Không bịa dữ liệu.** Usage thiếu vẫn để là `missing`. Một exporter không bao giờ
tuyên bố mức bền vững nó không có. Một ngân sách không đo được thì phải nói rõ.

**Quyền sở hữu là tường minh.** Một năng lực mới phải khai báo slot ghép nối, vòng
đời, và ai là người đóng nó.

## Thêm một package năng lực

1. Thêm package vào `packages/`.
2. Thêm nó vào `PACKAGE_RULES` trong `scripts/package-policy.mts` cùng tầng
   runtime, các phụ thuộc workspace, và các phụ thuộc runtime bên ngoài.
3. Khai báo bản đồ export trong chính `package.json` của package — không tuyến
   wildcard, không tuyến `require`, có `"./package.json"` tường minh.
4. Thêm một fixture người dùng trong `consumers/` cho hành trình mà nó mở ra.
5. Chạy `pnpm lint` và `pnpm check:docs`.
6. Thêm README theo đúng khuôn hiện có: tầng runtime, lệnh cài, cách dùng, slot
   ghép nối, vòng đời.

## Thêm một provider

Phần lớn endpoint **không cần package mới** — xem
[Thêm provider mới](/vi/09-providers/custom-provider). Nếu bạn định phát hành
một cái, hãy chạy bộ conformance:

```ts
import { runProviderConformanceSuite } from '@ai-agent-sdk/testkit'
const report = await runProviderConformanceSuite(fixture)
```

## Changeset

```bash
pnpm changeset
```

Mô tả thay đổi từ góc nhìn của người dùng. Một bản patch mà xoá hoặc thu hẹp một
export công khai thì không phải patch.

## Phụ thuộc

Phụ thuộc runtime mới cần được rà soát. `pnpm check:supply-chain` cưỡng chế:

- toàn vẹn SHA-512 trên mọi bản ghi trong lockfile;
- ghim chính xác mọi phụ thuộc runtime trực tiếp, dạng literal hoặc qua catalog
  nghiêm ngặt;
- script vòng đời đối chiếu danh sách `allowBuilds` đã rà soát;
- biểu thức SPDX của production đối chiếu danh sách cho phép trong thiết kế;
- không có phát hiện mức high/critical nào từ `pnpm audit --prod`.

Mọi ngoại lệ phải ghi rõ package, phiên bản chính xác, lý do, chủ sở hữu, và hạn
rà soát lại trong [chính sách phụ thuộc](/vi/14-project/dependency-policy).

`dangerouslyAllowAllBuilds` bị **cấm**.

## Nghiệm thu thủ công

Có những hành vi không thể chứng minh một cách tất định. Khi một thay đổi chạm
vào vòng lặp, hành vi provider, hoặc một ranh giới tích hợp, hãy chạy harness
tương ứng và ghi lại điều bạn quan sát được:

```bash
npm run human:basic
npm run human:deep
npm run human:hil
npm run human:mcp        # không cần thông tin xác thực
```

Các đường đi tới provider thật, tới mạng, và có dùng thông tin xác thực vẫn là
các tuyến nghiệm thu thủ công được giới hạn tường minh.

## Commit và PR

Commit dùng tiền tố quy ước (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Lịch
sử gần đây của repository là tài liệu tham khảo phong cách tốt nhất.

## Đọc tiếp

- [Kiểm thử và nghiệm thu](/vi/14-project/testing)
- [Chính sách phụ thuộc](/vi/14-project/dependency-policy)
