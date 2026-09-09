# Chính sách phụ thuộc và chuỗi cung ứng

Nguồn chân lý được máy cưỡng chế là `pnpm-workspace.yaml` và `pnpm-lock.yaml`.
Trang này ghi lại các ngoại lệ hẹp đã được rà soát.

## Cổng kiểm tra cưỡng chế những gì

```bash
pnpm check:supply-chain
```

- **Toàn vẹn SHA-512** trên mọi bản ghi trong lockfile; các phép phân giải lạ và
  không từ registry đều bị chặn.
- **Ghim chính xác mọi phụ thuộc runtime trực tiếp**, dạng literal hoặc qua
  catalog nghiêm ngặt.
- **Script vòng đời** đối chiếu các mục `allowBuilds` đã rà soát bên dưới.
- **Biểu thức SPDX của production** đối chiếu danh sách cho phép trong thiết kế.
- **Không có phát hiện mức high/critical** nào từ `pnpm audit --prod`.

Bộ kiểm tra đọc lockfile đã commit và các manifest đã cài **sau khi cài đặt với
lockfile đóng băng**. Nó không tải về hay chạy package nào để kiểm tra.

`strictDepBuilds: true` được bật. `dangerouslyAllowAllBuilds` bị **cấm**.

## Script vòng đời đã rà soát

Chỉ những package sau được phép chạy script cài đặt.

| Package | Phiên bản | Script | Vì sao cần chạy | Chủ sở hữu | Hạn rà soát lại |
| --- | --- | --- | --- | --- | --- |
| `esbuild` | `0.28.1` | `node install.js` | Kiểm tra/chọn binary nền tảng đã ghim trong registry mà Vite/tsdown dùng. Build và test trình duyệt cần tệp thực thi này. | Người bảo trì SDK | 2026-12-01 |
| `esbuild` | `0.18.20` | `node install.js` | Phụ thuộc công cụ của Drizzle Kit; script cài đặt chọn đúng package nền tảng tuỳ chọn và kiểm phiên bản của nó. | Người bảo trì SDK | 2026-12-01 |
| `esbuild` | `0.25.12` | `node install.js` | Phụ thuộc công cụ của Drizzle Kit; script cài đặt chọn đúng package nền tảng tuỳ chọn và kiểm phiên bản của nó. | Người bảo trì SDK | 2026-12-01 |
| `workerd` | `1.20260828.1` | `node install.js` | Kiểm tra/chọn binary nền tảng đã ghim trong registry mà Wrangler dùng cho test Worker nghiêm ngặt. | Người bảo trì SDK | 2026-12-01 |

Tất cả đều là tarball từ registry có toàn vẹn lockfile, và binary nền tảng của
chúng được biểu diễn dưới dạng **phụ thuộc tuỳ chọn ghim phiên bản chính xác**.

Một lần nâng cấp phải rà soát lại package, phiên bản, script vòng đời, nguồn,
toàn vẹn, và tập phụ thuộc nền tảng **trước** khi đổi danh sách cho phép.

## Giữ lại bộ phân tích SSE

Workspace giữ đúng `eventsource-parser@4.1.0` trong
`@alvin0/ai-agent-sdk-provider-http`, sau khi ứng viên parser tự viết không đạt **cổng
hiệu năng đã tuyên bố trước**. Quy tắc và bằng chứng nằm trong
`docs/dependency-policy.md`.

| Thuộc tính | Trạng thái |
| --- | --- |
| Script vòng đời | Không có |
| Chủ sở hữu trực tiếp | Chỉ `@alvin0/ai-agent-sdk-provider-http` |
| Toàn vẹn registry, giấy phép, phân giải đóng băng | Cổng phát hành |
| Hành vi runtime khi đã đóng gói | Cổng phát hành |
| Cảnh báo bảo mật | Cổng phát hành |

Một cảnh báo mức high hoặc critical sẽ **đình chỉ việc phát hành**, chứ không cho
phép tự động nâng cấp hay dùng một phương án dự phòng chưa được thẩm định. Lần
audit production ngày 2026-09-01 không tìm thấy cảnh báo nào ở mọi mức nghiêm
trọng.

## Parser YAML cho metadata skill

`@alvin0/ai-agent-sdk-skill-filesystem` sở hữu trực tiếp đúng `yaml@2.9.0`. Parser đọc
policy `agents/openai.yaml` có giới hạn, tắt alias và từ chối metadata trùng key,
sai cú pháp, quá sâu hoặc quá lớn. Toàn vẹn, giấy phép ISC, hành vi runtime sau
đóng gói và cảnh báo bảo mật đều là cổng phát hành. Hạn rà soát: 2026-12-06.

## Quyết định về tuổi bản phát hành

Ngày 2026-09-01, pnpm đã đúng khi từ chối `@opentelemetry/api-logs@0.222.0`: bản
đó được publish chưa đầy 24 giờ. Workspace ghim bản `0.221.0` đã chín, thay vì
lách qua `minimumReleaseAge: 1440`.

Adapter OpenTelemetry phải chạy bộ test tương thích API với đúng phiên bản đó
trước khi tách ra.

## Xuất xứ của các GitHub action

Workflow bắt buộc ghim các action chính thức vào **commit phát hành bất biến, có
ký**:

| Action | Bản phát hành | Commit |
| --- | --- | --- |
| `actions/checkout` | `v7.0.0` | `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` |
| `actions/setup-node` | `v6.0.0` | `2028fbc5c25fe9cf00d9f06a71cc4710d4507903` |

Workflow cài đúng `pnpm@11.25.0`, **với script vòng đời bị tắt**, trước khi chạy
cài đặt workspace với lockfile đóng băng.

## Thêm một ngoại lệ

Mọi ngoại lệ trong tương lai phải ghi lại, trong `docs/dependency-policy.md`:

- package
- phiên bản chính xác
- lý do
- chủ sở hữu
- hạn rà soát lại

Một ngoại lệ không có ngày hết hạn thì không phải ngoại lệ — nó là một khoản nợ
vĩnh viễn.

## Đọc tiếp

- [Đóng góp](/vi/14-project/contributing)
- [Bảo mật và quyền riêng tư](/vi/10-advanced/security)
