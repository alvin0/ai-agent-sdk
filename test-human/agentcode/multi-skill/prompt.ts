/** Release-rescue prompt used by the real multi-skill AgentCode acceptance run. */

export const SIGNAL_DESK_REQUIRED_SKILLS = Object.freeze([
  'systematic-debugging',
  'vercel-react-best-practices',
  'playwright-skill',
] as const)

/**
 * The prompt intentionally describes domains instead of naming skill IDs. This
 * makes the run test metadata routing, activation, and application rather than
 * simple compliance with an explicit list.
 */
export const SIGNAL_DESK_PROMPT = `Bạn đang tiếp quản release candidate “Signal Desk”, một React + TypeScript +
Vite + Zustand signal-triage desk offline-first. Đây là dự án có sẵn; không scaffold
lại và không viết lại toàn bộ kiến trúc.

Hãy sử dụng catalog skill theo progressive disclosure: tự chọn skill từ metadata
khi một giai đoạn thật sự liên quan, load skill trước khi áp dụng, và chỉ đọc các
resource nhỏ cần thiết. Không dùng workspace tools để xem folder skill.

Yêu cầu:

1. Trước bất kỳ chỉnh sửa source nào, chạy npm test, đọc đầy đủ các lỗi liên
   quan, tái hiện chúng và xác định root cause. Không đoán sửa, không xóa/skip/
   nới lỏng test và không thay đổi assertion chỉ để có màu xanh.

2. Sửa event-log semantics:
   - append sau undo phải xóa redo branch;
   - replay vẫn deterministic;
   - undo/redo và API hiện tại phải được giữ nguyên.

3. Làm persistence an toàn:
   - dùng key có version “signal-desk:events:v2”;
   - chỉ lưu durable event log, không lưu projection/filter/UI state;
   - malformed JSON, storage bị disable hoặc quota failure không được làm app
     crash;
   - thao tác vừa thực hiện phải còn nguyên sau reload.

4. Audit và refactor React/Zustand theo hướng hiệu năng nhưng giữ nguyên behavior:
   - tránh subscription rộng không cần thiết;
   - derived filtered data không được đồng bộ qua effect;
   - component identity phải ổn định;
   - tránh repeated linear lookup khi render board.
   Chỉ áp dụng optimization có bằng chứng từ code hiện tại, không thêm abstraction
   không cần thiết.

5. Thêm Playwright E2E thực:
   - config dùng baseURL và webServer;
   - test tạo một critical signal, đổi status từ New sang Investigating và
     filter theo title;
   - test reload chứng minh incident mới nhất được lưu;
   - dùng locator theo role/label và web-first assertions;
   - không dùng waitForTimeout, CSS/XPath locator dễ vỡ hoặc test-order dependency.

6. Bổ sung regression tests cần thiết và viết docs/verification.md nêu root
   causes, quyết định refactor, resource skill đã dùng và bằng chứng command.

Chỉ hoàn thành sau khi đã quan sát thành công cả:
npm test
npm run build
npm run e2e

Báo cáo cuối phải ghi exit code và số test của từng gate. Preserve mọi phần tốt
đang có và không tuyên bố pass nếu chưa quan sát tool result.`

export const SIGNAL_DESK_REVIEW_PROMPT = `Hãy audit lần cuối như một release
reviewer độc lập. Giữ nguyên các sửa đổi đã đúng, kiểm tra rằng Playwright không
có arbitrary waits và corrupted legacy storage không làm blank screen, thêm
regression còn thiếu rồi chạy lại cả ba release gates. Không bắt đầu lại từ đầu.`
