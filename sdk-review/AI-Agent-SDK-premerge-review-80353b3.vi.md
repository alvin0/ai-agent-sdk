# Deep review trước merge — AI Agent SDK

**Repository:** `dinh-ai-system-exe-com-vn/ai-agent-sdk`  
**Nhánh:** `mono-package`  
**Snapshot:** `80353b38da2411450a5c4e0c1e6ce7e4c5cdebf7`  
**Ngày review:** 06/09/2026  
**Kết luận:** Chưa duyệt merge để bật mặc định trong production.

## 1. Phạm vi và độ chắc chắn

Review tập trung vào đường thực thi runtime → session → agent mode → model/tool loop → history/memory/report; ownership và đóng tài nguyên; hậu kiểm tool; HTTP provider; HTTP MCP; filesystem skills; cấu hình CI/dependency; các test liên quan được đọc trực tiếp.

Đã đọc source ở snapshot cố định qua GitHub, đối chiếu CI run `34005241091`, job `101411089799`, và chạy bốn kiểm tra cơ chế JavaScript tối giản. Chưa clone/build/chạy toàn bộ repository trong môi trường review vì đường truy cập Git từ container không hoạt động. Bốn kiểm tra cục bộ không import SDK: chúng kiểm tra đoạn logic trích hoặc mô hình Promise tương ứng, không phải bằng chứng full integration pass.

Không có kết quả heap snapshot, soak test, live-provider test, pnpm audit hoàn chỉnh, penetration test, hoặc kiểm tra tương thích với code của hệ thống đích. Không thay đổi source, không tạo commit/PR, không dùng API key hoặc thực hiện tool nghiệp vụ thật.

Các nhãn trong báo cáo:

- **Xác nhận source:** chỉ ra được nhánh điều khiển hoặc đường tham chiếu cụ thể.
- **Tái hiện cơ chế:** đã chạy ví dụ JavaScript tối giản; phạm vi hẹp hơn chạy SDK.
- **Rủi ro tích hợp:** mức ảnh hưởng phụ thuộc vào trust boundary và cách host sử dụng SDK.
- **Cần kiểm thử:** chưa có bằng chứng động đủ để kết luận hiện tượng dưới tải thực tế.

## 2. Quyết định merge

| ID | Vấn đề | Ưu tiên đề xuất | Căn cứ |
|---|---|---|---|
| R01 | CI dừng trước build/test/audit vì toolchain không tương thích | P1 — chặn merge | CI và log của đúng snapshot |
| R02 | Runtime giữ team đã đóng, cùng session/history/mailbox | P1 — chặn khi runtime sống lâu và team được tạo động | Đường strong reference trong source |
| R03 | Scheduler quan sát rejection quá muộn; lỗi admission có thể bỏ lại sibling đã chạy | P1 — chặn merge | Source; tái hiện cơ chế Promise |
| R04 | Hậu kiểm `block`/`replace` không loại bỏ mọi kênh dữ liệu | P1 — chặn khi dùng pipeline này làm ranh giới bảo mật | Source; tái hiện finalizer |
| R05 | MCP private-network guard không xác minh DNS/IP đích; mặc định HTTP policy khá mở | P1 có điều kiện | Source; chưa thực hiện khai thác mạng |
| R06 | History append-only, snapshot/copy lớn; public facade thiếu nhiều nút giới hạn | P2; chặn rollout tải lớn nếu chưa có sizing | Source; chưa đo heap/RSS |
| R07 | Parser policy YAML có thể đổi `false` thành mặc định cho phép khi thêm comment | P2; P1 nếu dùng để bảo đảm chỉ gọi skill thủ công | Source; tái hiện biểu thức parser |

R01–R04 cần được giải quyết hoặc có quyết định kiến trúc rõ ràng kèm lớp bảo vệ thay thế được kiểm thử trước khi bật production. R05 phải đóng trước khi nhận MCP endpoint từ tenant/người dùng. R07 nên sửa trong cùng vòng vì ảnh hưởng trực tiếp tới ngữ nghĩa policy và phạm vi thay đổi tương đối nhỏ.

Một feature branch tồn tại trong repository không đồng nghĩa đang bật production. Nếu chỉ merge mã dưới feature flag tắt, vẫn cần CI xanh và không làm hỏng đường chạy hiện hữu; đó không phải duyệt readiness của SDK.

## 3. Mô hình SDK đang chạy

Đây không chỉ là wrapper gọi model. Nó kết hợp provider registry, runtime composition, session state, agent loop, tool scheduling, skills, memory persistence, team coordination và accounting/observation. Workspace có nhiều package dù nhánh có tên `mono-package`. Root package tổ chức build nhiều package; low-level API và composition API cùng tồn tại. [S01, S02]

```text
Host / application
  └─ createAgentRuntime(...)
       ├─ Provider registrations / model catalog
       ├─ RuntimeOperations: admission, cancellation, close reporting
       ├─ Observation / exporters
       ├─ agent(definition)
       │    └─ createSession / resumeSession
       │         └─ run / stream
       │              ├─ acquire agent-run lease
       │              ├─ load memory, prepare tools, discover skills
       │              ├─ runAgent: basic / deep / deep-human-in-loop
       │              │    └─ runTurn
       │              │         ├─ modelRound
       │              │         └─ runToolCalls
       │              │              prepare → authorize → dispatch → finalize
       │              ├─ history updates / memory commit
       │              └─ report, events, release lifecycle state
       └─ team(...)
            ├─ local member sessions
            ├─ mailbox / wake-up work
            └─ linked remote transports
```

`deep` thêm cơ chế tự nộp kết quả bằng control tool, không tự biến execution thành workflow bền vững. `maxTurns` được mô tả là số iteration bình thường; forced final answer có thể cần thêm một request. Vì vậy không nên suy ra số request tính phí tuyệt đối chỉ từ `maxTurns`. [S03]

### Phần kiến trúc nên giữ

Core và protocol/provider adapters được tách; Node-only functionality có package riêng. Runtime capture cấu hình và callback nhằm giảm mutation trong lúc chạy. History/tool output có clone/freeze và giới hạn. Tool thiếu approver khi cần approval bị từ chối. Provider HTTP dùng HTTPS mặc định, manual redirects, giới hạn request/response/SSE và controller cleanup. Có budget, vòng lặp chống lặp tool, reporting về usage không đầy đủ, và close reporting cho operation chưa settle. [S02–S09]

Không đề xuất viết lại toàn bộ. Ưu tiên sửa ownership, cancellation, scheduling và policy semantics trước khi thêm abstraction hoặc feature mới.

### Ranh giới cần giữ ở host

Đề xuất dùng SDK làm execution engine trong process, không mặc nhiên giao cho SDK các bảo đảm distributed durable execution, tenant authorization, transaction nghiệp vụ, idempotency, ingress/egress security hay giới hạn tải toàn dịch vụ. Mỗi bảo đảm phải có owner cụ thể và test riêng ở lớp host.

## 4. Findings chi tiết

### R01 — CI chưa chứng minh được bất kỳ gate chất lượng nào ở snapshot này

**Vị trí:** `.github/workflows/ci.yml`, `package.json`, `scripts/check-supply-chain.mts`.

Workflow pin Node `22.12.0`, cài `pnpm@11.25.0`, rồi gọi frozen install. Log job báo pnpm yêu cầu Node `>=22.13`, trong khi runner là `v22.12.0`; bước install thất bại. Các bước graph/build/type, baseline tests, package tests, packed-consumer checks và supply-chain audit phía sau bị skip. [S01, S10]

Ngoài lỗi đã xảy ra, root scripts gọi trực tiếp nhiều file `.mts`. Nâng riêng Node lên `22.13` không giải quyết đầy đủ: tự chạy TypeScript không cần flag chỉ được bật mặc định từ Node `22.18.0` trong nhánh 22. Script supply-chain có type annotations thật, không chỉ đổi đuôi file. [S11, E01]

**Ảnh hưởng:** không thể dùng sự hiện diện của test/audit scripts để kết luận chúng đã pass. Audit CVE ở snapshot này còn chưa được xác minh.

**Sửa đề xuất:** xác định riêng build-toolchain minimum và consumer-runtime minimum; pin một patch LTS được hỗ trợ đáp ứng các công cụ; thống nhất CI, engines, tài liệu và local setup; hoặc dùng TypeScript runner/compile scripts được pin. Chạy lại toàn bộ frozen install → build/type → tests → pack → audit. Không dùng `--force`, bỏ engine checks hay `continue-on-error` để biến gate đỏ thành xanh.

**Điều kiện đóng:** CI xanh trên SHA sau sửa; không có job quan trọng bị skip; có log pack/consumer tests và audit thực tế.

### R02 — Team đã đóng vẫn giữ dữ liệu nặng qua runtime owner

**Vị trí:** `composition/runtime/owner.ts` → `team()`/`teams`; `composition/team/runtime.ts` → `RuntimeTeamValue`/`close()`; `agent/team/team.ts` → `dispose()`.

Owner giữ `RuntimeTeamRegistration[]` và `push` mỗi team mới. `RuntimeTeamValue` giữ `sessions` Map. `close()` đặt cờ và gọi `team.dispose()`, nhưng không xóa map session khỏi registration. Low-level dispose xóa roster/links, không làm owner thôi giữ registration. Mailbox vẫn là trường của team. [S04, S05, S12]

```text
Long-lived runtime
  → teams[]
    → closed RuntimeTeamValue
      → sessions Map
        → AgentSession
          → History / memory / captured tools
      → AgentTeam
        → mailbox
```

Đây là đường giữ strong reference có thể chỉ ra trong source. Không cần khẳng định GC bị lỗi; GC không được phép thu hồi dữ liệu còn reachable. Chưa đo độ dốc heap hay số byte leak trên một team.

**Tình huống ảnh hưởng:** server tạo team theo request/job, đóng team rồi bỏ biến local, nhưng runtime được tái sử dụng lâu dài. Đóng object không đủ nếu owner vẫn giữ toàn bộ state của nó.

Có test `closes early idempotently and retains one closed component in runtime reporting`; việc giữ thông tin report là có chủ ý. Tuy nhiên report chỉ cần metadata, không cần toàn bộ session/history. [S13]

**Sửa đề xuất:** sau khi settle công việc, unregister live registration hoặc thay bằng tombstone nhỏ `{kind,id,status,errorSummary}`; giải phóng map session/mailbox/callback khi hợp đồng cho phép; giới hạn retention của tombstone; giữ idempotency và khả năng báo cáo team đã đóng. Không chỉ xóa `teams[]` khi runtime cuối cùng đóng, vì đó không sửa tăng trưởng trong lúc service đang sống.

**Kiểm thử:** lặp create → inject/run → close → bỏ handle hàng nghìn vòng trên cùng runtime, quan sát số live registrations, member sessions, listeners, heap retaining path và heap sau GC/warm-up. Test báo cáo closed component vẫn phải pass.

### R03 — Scheduler chưa sở hữu Promise và cleanup đầy đủ trên mọi đường lỗi

**Vị trí:** `agent/loop/schedule.ts` → `runToolCalls()`, `start()`, `commit()`; `agent/tool/pipeline.ts` → `dispatchAuthorizedToolCall()`.

#### A. Rejection được quan sát quá muộn

`start()` trả slot chứa `pending: dispatchAuthorizedToolCall(...)`. Vòng lặp tiếp tục `await start()` cho sibling kế tiếp, và chỉ trong vòng commit sau đó mới gắn handler qua `raceWithSignal(slot.pending, ...)`. [S07]

Tool đầu có thể phát sinh fatal error hoặc `around` interceptor reject trong khi sibling sau đang chờ approval/authorization. Promise đầu đã reject nhưng chưa có handler. Node mặc định có thể kết thúc process với exit code 1 khi rejection không được xử lý kịp. [E02]

Kiểm tra tối giản cục bộ mô hình hóa đúng quan hệ thời gian này: delayed handler cho exit 1; gắn handler ngay cho exit 0. Đây là bằng chứng cơ chế JavaScript, chưa phải chạy nguyên scheduler SDK.

#### B. Lỗi trong quá trình tạo segment bỏ qua drain

Đoạn `try/catch` để commit/drain các sibling nằm sau vòng dựng segment. Nếu `prepare()` hoặc `start()` của sibling tiếp theo throw, execution rời hàm trước khi tới vòng drain của các slot đã dispatch. Ví dụ: A đã chạy, `before` của B throw. [S07]

**Ảnh hưởng:** process crash hoặc tool vẫn chạy ngoài vòng đời run đã kết thúc. Với tool có side effect, state của run có thể đã báo lỗi trong khi tác động ngoài hệ thống vẫn tiếp tục.

**Sửa đề xuất:** observe rejection ngay khi tạo Promise; lưu outcome không reject ngoài kiểm soát nhưng vẫn giữ lỗi để propagate; bọc toàn bộ segment admission/dispatch/commit trong ownership scope; mọi exit phải cancel và bounded-drain tất cả task đã bắt đầu; không làm mất ordered history commit. Nếu hết teardown deadline, báo unsettled rõ ràng và quarantine resource phù hợp thay vì giả định tác vụ đã dừng.

**Kiểm thử:** fatal A + approval B bị park; slow A + before B throw; prepare next call throw; abort khi đang tạo segment; failure trong emit/checkpoint; fatal ở sibling giữa. Assert không có `unhandledRejection`, không có task mất owner và không có side effect xuất hiện sau khi run tuyên bố clean settlement.

### R04 — Post-policy không phải ranh giới chặn/redact toàn bộ dữ liệu

**Vị trí:** `agent/tool/pipeline.ts` → `finalizeToolCall()`; `agent/loop/schedule.ts` → `commit()`; `composition/agent/session.ts` → `projectEvent()`.

#### `block` vẫn chuyển additional context tới model

Nhánh block tạo failure nhưng copy nguyên `executed.additionalContext`. Sau đó commit append `additionalContext` thành message user-role với source ứng dụng, bất kể result là error. Tool gọi `ctx.addContext(...)` vì thế vẫn đưa nội dung vào history và request model kế tiếp dù hậu kiểm đã block. [S08, S07]

#### `replace` vẫn giữ dữ liệu gốc

Nhánh replace dùng spread `...executed`, chỉ đổi `content` và tùy chọn `meta`. `value` gốc và `additionalContext` không bị loại bỏ. Public event projection xuất `output: event.result`, nghĩa là consumer nhận lại toàn bộ envelope. Span-end còn sử dụng value cho đường success. [S08, S14]

```text
Tool: value chứa sentinel, content chứa sentinel
After-policy: content = [REDACTED]
Public tool-result: output.value vẫn chứa sentinel
```

**Lưu ý contract:** `agent/tool/definition.ts` chủ ý tách raw `value` dùng cho UI/log/replay khỏi model-facing `content`. Vì vậy việc replace giữ value không tự nó chứng minh một CVE hay vi phạm contract hiển thị; finding này chặn cách tích hợp coi replace/block là sanitizer toàn cục. Cần quyết định rõ sửa API, thêm security sanitizer, hay giữ content-only semantics và bảo vệ các sink ở host.

**Độ chắc chắn:** xác nhận source và tái hiện logic finalizer. Không khẳng định exporter mặc định gửi bí mật ra bên ngoài, vì còn phụ thuộc exporter/host. Nhưng pipeline hiện tại không đủ để host coi `block`/`replace` là DLP toàn diện.

**Sửa đề xuất:** xác định rõ contract. Nếu `block` là security boundary, loại bỏ value/content bổ sung/meta chứa dữ liệu, chỉ giữ feedback an toàn. Nếu `replace` là sanitize, trả envelope đã sanitize đầy đủ, không spread raw result. Tách audit-only raw channel nếu thật sự cần, với quyền/retention độc lập. Nếu API chỉ muốn thay nội dung hiển thị, đặt tên và tài liệu rõ là `replaceContent`, rồi cung cấp một sanitizer khác trước mọi sink.

Post-policy không thể hoàn tác một side effect tool đã thực hiện. Quyền gọi tool, tenant scope và approval phải kiểm tra trước dispatch.

**Kiểm thử:** marker giả không xuất hiện trong next model request, user-visible events, report, telemetry sink và history projection thuộc scope đã hứa sanitize. Test riêng value, content, additionalContext, meta và lỗi render fallback.

### R05 — MCP URL policy không đủ làm SSRF boundary cho input không tin cậy

**Vị trí:** `packages/mcp/src/client/http-security.ts`.

`snapshotHttpSecurityOptions()` tạo defaults bằng `requireHttps === true`, `allowPrivateNetwork !== false`, `allowRedirects !== false`. Khi caller không cấu hình, HTTPS không bắt buộc, private network và redirects được cho phép. Đây có thể phù hợp local development, nhưng không phải profile an toàn để expose tenant-configurable endpoints. [S15]

Ngay cả `allowPrivateNetwork: false`, validator chỉ chạy `isPrivateHostname(url.hostname)`. Nó phát hiện một số hostname/private IP literal nhưng không biết hostname công khai đang trỏ vào địa chỉ nội bộ nào. Callback `validateEndpoint` có kiểu đồng bộ và không được await, nên không thể coi đó là một DNS guard async có sẵn. [S15]

**Mức độ:** P1 nếu ứng dụng cho tenant/người dùng nhập URL rồi server fetch. Chưa có bằng chứng khai thác SSRF thực tế; đây là giới hạn của implementation được xác nhận. Endpoint do operator tin cậy cấu hình và bị chặn egress có threat model khác.

**Sửa đề xuất:** một server-hardened factory/preset với HTTPS, trusted origin allowlist, redirects tắt hoặc kiểm tra chặt; kiểm soát network egress tại proxy/firewall; khi cần URL động, kiểm tra A/AAAA và ràng buộc địa chỉ kết nối để không còn khoảng trống giữa validation và request. Không dùng duy nhất regex/string blocklist. OWASP cũng phân biệt rõ application validation và network-layer controls. [E03]

Test redirect và xóa credential trên cross-origin đã có trong repo; đó là điểm tốt nhưng không bao phủ DNS resolution/connection binding. [S16]

### R06 — History có trần, nhưng trần không đồng nghĩa footprint nhỏ hoặc được giải phóng bởi compaction

**Vị trí:** `agent/history/history.ts`, `agent/history/config.ts`, `agent/accounting/event-buffer.ts`, `composition/agent/types.ts`.

History là append-only log; projection có thể thay đổi nhưng log vẫn giữ entries cũ. Defaults là 100.000 entries, 16 MiB/entry, 128 MiB tổng kích thước serialize. `snapshot()` structuredClone toàn bộ log rồi freeze. Event buffer có trần 100.000 events/16 MiB. [S17–S19]

Đây là **bounded retention**, không phải bằng chứng mọi session đều memory leak. Tuy nhiên số session/team tổng và các bản copy có thể làm footprint tăng đáng kể. Một trăm history cùng ở trần tương ứng 12,5 GiB dữ liệu serialize, chưa nói đến snapshot, tool result, buffer và overhead. Con số này là minh họa dung lượng, không phải phép đo RSS/heap.

Tool result limit 4 MiB được kiểm tra khi result đã được tạo và serialize; nó không ngăn tool tự cấp phát object rất lớn trước khi trả về. `maxParallel` cũng là giới hạn của scheduler/batch, không phải semaphore cho toàn bộ request của host. [S07]

Public `RuntimeAgentLimits` chỉ lộ một phần nhỏ bounds; `RuntimeAgentSessionOptions` không có historyLimits. Nhiều knob tồn tại ở lower-level nhưng host đi qua API composition không trực tiếp đặt được. [S20]

**Sửa đề xuất:** expose coherent resource limits ở public API; tách durable audit log khỏi model projection/hot working set; rollover/archive theo contract rõ ràng; tránh snapshot lớn ở mỗi hook nếu chỉ cần delta; externalize payload lớn thành artifact có quyền truy cập. Host cần cap concurrent runs và tổng live sessions/teams, không chỉ per-tool/per-history limit.

**Kiểm thử:** snapshot/hook frequency khi history dài, slow consumer, large tool output, many parallel sessions, repeated compaction, history gần trần sau tool có side effect. Đo heapUsed/external/RSS, event-loop delay, active handles và retained objects; không kết luận leak chỉ từ RSS chưa hạ ngay.

### R07 — Parser policy YAML có hành vi fail-open với inline comment

**Vị trí:** `packages/skill-filesystem/src/provider/filesystem-provider.ts` → `readImplicitPolicy()`, `parseSkillMetadata()`, `parseSkillFile()`.

Parser dùng biểu thức kết thúc dòng sau `true|false`, rồi quy `undefined` thành không cấm implicit invocation. Với YAML:

```yaml
policy:
  allow_implicit_invocation: false # explicit invocation only
```

regex không match; `allowImplicit` trở thành `undefined`; kiểm tra `allowImplicit !== false` trả true. Bỏ comment đi thì trả false. Đã tái hiện biểu thức này cục bộ. [S21]

Comment không được thay đổi dữ liệu biểu diễn của YAML; cách parse ở đây là nguồn lỗi, không phải yêu cầu người viết cấu hình không dùng comment. [E04]

**Tác động:** policy chỉ gọi skill khi được yêu cầu có thể bị diễn giải thành cho model gọi. Không đồng nghĩa vượt qua mọi quyền tool, vì tool authorization là lớp khác.

**Sửa đề xuất:** dùng YAML parser có schema/size/depth/alias limits, reject duplicate hoặc malformed policy keys, và xác định rõ đường dẫn key. Nếu chủ ý hỗ trợ một subset, phải fail closed khi key policy xuất hiện nhưng không parse được. Front matter parser tự viết cũng nên được kiểm thử với multiline scalar, quoting, nested mappings và comments.

**Kiểm thử:** false có/không comment, true có/không comment, policy malformed, duplicate key, missing file và missing key; phân biệt rõ missing hợp lệ với dữ liệu sai.

## 5. Security và correctness cần chốt tại lớp host

### 5.1 Tenant boundary của memory

`memoryStoreKey()` trả nguyên fixed key hoặc tuple namespace/agentId/conversationId. Có encoding tránh nhập nhằng delimiter, nhưng không tự sinh tenant authorization. Host phải xây namespace/key từ tenant đã xác thực; không dùng mỗi conversationId do client gửi. Fixed scope là shared memory có chủ ý, chỉ dùng khi đó thực sự là yêu cầu. [S22]

Store nhận `expectedRevision`; tốt cho CAS, nhưng adapter lưu trữ của host phải thực thi so sánh revision atomically. Cần test hai process commit cùng conversation, conflict/retry, load thất bại, commit thất bại và abort sau khi transaction đã commit. [S23]

### 5.2 Side effect và retry

Tool body thực thi trước khi finalized history/report được công bố. Không nên retry nguyên run một cách mù quáng nếu run có quyền ghi. Host cần idempotency key gắn business operation/tool call, durable receipt/outbox thích hợp và trạng thái outcome-unknown khi timeout chưa biết external effect thành công hay chưa. Memory CAS không thay thế idempotency của thao tác nghiệp vụ.

### 5.3 Tool code không phải sandbox

Tool callback chạy in-process; AbortSignal là cơ chế hợp tác, không thu hồi được mọi quyền hoặc ngăn CPU loop chặn event loop. SDK đã có nhiều timeout/settlement limits, nhưng không nên suy ra rằng timeout giết được công việc bên ngoài. Tool không tin cậy cần worker/process/container/remote executor bị giới hạn tài nguyên và quyền.

`parameters` là schema gửi model; đường prepare cho phép `parse` vắng mặt và source ghi rõ khi đó JSON chưa được validate; đây là contract sử dụng có chủ ý. Vì vậy host không nên nhầm có JSON Schema với đã validate argument trước execute: cần runtime parsing/validation và kiểm tra tenant/resource ownership trong từng tool nhạy cảm. [S08]

### 5.4 Filesystem roots không mặc nhiên là sandbox

Discovery có canonicalize thư mục skill và có thể đi qua directory symlink. `SKILL.md`/metadata được mở theo path; resource reader có realpath containment nhưng không biến toàn bộ discovery root thành sandbox trước local filesystem mutation. [S21]

Đây là rủi ro có điều kiện, chưa kết luận exploit cho cấu hình hiện tại. Với untrusted repo/upload: dùng read-only vetted roots, chặn symlink/junction ngoài allowlist, kiểm tra file type, và cân nhắc TOCTOU/OS boundary. Không cấp cho agent quyền đọc toàn bộ filesystem chỉ vì provider có root option.

### 5.5 Logging và observability

HTTP provider có redact credential headers và default request observer no-op. Nhưng compatibility `observeRequest()` được mô tả high-risk và nhận raw request body. Không bật wire prompt logging trong production chỉ để debug tiện. Public tool events cũng là sink dữ liệu cần sanitize như R04. [S09, S14]

Cần policy về retention, access control, PII/secret redaction và audit availability; kiểm tra log/audit exporter chết, queue đầy, lỗi flush/close, partial delivery và restart. Việc có test filenames cho những vùng này không thay thế chạy chúng.

## 6. Nợ công nghệ cần quản lý

| Nợ | Quan sát | Hướng xử lý |
|---|---|---|
| Hai bề mặt API | Root core vẫn export low-level registry/plugin bên cạnh composition; source ghi compatibility debt | Chốt API được host sử dụng; kế hoạch deprecation/versioning; migration tests |
| Nhiều state machine vòng đời | Runtime operations, wrapper session, legacy session, runAgent/runTurn, scheduler, teams cùng quản lý trạng thái | Một ownership contract rõ; fencing và cancellation helpers thống nhất |
| Các implementation async lặp lại | race-with-signal, bounded wait, iterator cleanup ở nhiều module | Centralize primitive có semantics thống nhất, test pre-aborted/late-rejection/late-settle |
| Mô hình retention gắn với object sống | Closed component reporting giữ live registration | Tombstone nhẹ, bounded report retention, dispose payload |
| Streaming có nhiều lớp | Backpressured queue ở loop nhưng eager bounded event buffer ở run handle | Ghi rõ eager/lazy, tiêu thụ events/result/report, overflow và early-return behavior |
| Public limits không đồng đều | Lower-level có nhiều bounds hơn RuntimeAgentLimits | Một resource-limits object được propagate đầy đủ, test public path |
| Event status mất độ phân biệt | Public type có aborted/rejected nhưng projector tool-result chỉ map failed/completed | Mapping dựa stable error codes, hoặc thu hẹp type contract cho đúng |
| Toolchain/typing drift | Node minimum22.12 nhưng type catalog Node26 và direct `.mts` scripts | Runtime compatibility matrix và build-toolchain policy; không dựa typecheck đơn thuần |
| Parser cấu hình tự viết | Front matter/YAML policy được regex/split thủ công | Parser chuẩn hoặc subset được đặc tả, fail-closed, fuzz/config fixtures |

Các mục trên là backlog kiến trúc, không phải tất cả đều phải rewrite trước merge. R02–R04 là nơi nợ đó đã tạo ra failure mode cụ thể. [S02, S04–S08, S14, S20, S21, S24]

## 7. Gói kiểm thử kèm theo

### Đã chạy cục bộ

`mechanism-repros.mjs` chỉ dùng Node built-ins. `mechanism-results.json` ghi Node `v22.16.0`, SHA đích, scope và bốn quan sát:

1. block giữ additionalContext;
2. replace giữ value/context gốc;
3. inline YAML comment làm false bị hiểu thành default allow;
4. delayed Promise handler cho process exit1, immediate-handler control exit0.

Các test này kiểm tra hành vi lỗi tồn tại, nên runner thoát thành công khi tái hiện đúng. Điều đó không có nghĩa SDK an toàn hoặc đã pass regression contract.

### Chưa chạy với repository

`premerge-review.regression.spec.ts` đề nghị copy vào `tests/unit/composition/`. Năm test dùng mock/local filesystem, không cần paid model API: block additionalContext, replace public event, closed-team ownership, scheduler admission drain và policy YAML comment.

Chúng mô tả merge-safety contract đề xuất và dự kiến một số test fail trên snapshot hiện tại. Hai test post-policy đòi hỏi thống nhất contract sanitize trước khi duy trì lâu dài. Ownership test là white-box, cần chỉnh nếu đổi cấu trúc owner. Chưa xác minh typecheck hoặc Vitest execution của file này trong full workspace.

```sh
# Chạy các kiểm tra cơ chế độc lập:
node mechanism-repros.mjs

# Sau khi sửa toolchain, trong repository:
pnpm install --frozen-lockfile
pnpm exec vitest run tests/unit/composition/premerge-review.regression.spec.ts
# Sau đó chạy đầy đủ CI scripts hiện có, không chỉ file regression mới.
```

## 8. Acceptance gates trước production

| Gate | Bằng chứng cần có | Dừng rollout khi |
|---|---|---|
| Toolchain/build | Frozen install, type/build/graph, packed imports đều pass trên SHA cuối | Gate fail hoặc skip không giải thích |
| Runtime failure | Fatal/approval/admission/abort matrix; không unhandled rejection | Process crash, task không còn owner |
| Lifecycle/retention | Create-close churn, heap retaining paths, active counters về baseline | History/team tăng tuyến tính sau close |
| Output policy | Sentinel không qua sink thuộc phạm vi block/redact đã cam kết | Dữ liệu gốc còn trong event/model/audit sai quyền |
| Network/filesystem | Tenant input threat model; allowlist, DNS/egress, redirect, symlink tests | URL/file có thể thoát scope đã cam kết |
| Persistence/effects | Tenant isolation, atomic CAS, duplicate-request/idempotency tests | Cross-tenant data, lost update, duplicate side effect |
| Capacity | Concurrent sessions, slow consumers/exporters, large payloads, near-limit history | Unbounded queue/retention, event-loop stall không kiểm soát |
| Live integrations | Các provider/MCP transports thực sự sẽ dùng; auth refresh, stream cut, rate limit | Usage/termination sai, retry làm lặp effect |
| Rollback | Host facade, feature flag và đường rollback đã thử | Không thể quay về engine cũ mà giữ consistency |

Gợi ý profile kiểm thử ban đầu: hàng nghìn đến 10.000 create/close cycles, nhiều mức concurrent sessions, consumer/exporter chậm, abrupt cancellation và inject faults tại mọi await boundary. Đây là profile đề xuất, không phải SLA hay số đo đã đạt. Pass/fail heap nên dựa baseline/warm-up và retaining paths, không đặt một ngưỡng RSS tùy ý.

Triển khai ban đầu qua facade riêng của host. Shadow test chỉ dùng read-only tools hoặc recorded/replayed effects; không chạy hai engine cùng ghi production để so sánh. Mở canary sau khi đóng blocker, theo SLO và quota của hệ thống đích.

## 9. Những phần chưa được sign-off

Không có kết luận toàn bộ OAuth/token storage, A2A protocol server, MCP server/authentication, toàn bộ provider protocol corner cases, CVE/license state thực tế của installed graph, packed artifacts, browser/worker runtime matrix hay integration parity với hệ thống chính. Các vùng này cần chạy gate phù hợp sau khi sửa toolchain và blocker; không được hiểu sự im lặng trong báo cáo là không có lỗi.

## 10. Bản đồ source evidence

Mọi đường dẫn dưới đây thuộc snapshot ghi ở đầu báo cáo. Một số file lớn được đọc theo các đoạn liên quan; danh sách này không khẳng định full-repository coverage.

| Ref | Source / điểm kiểm tra |
|---|---|
| S01 | `package.json` — engines, packageManager, scripts/build graph |
| S02 | `packages/core/src/index.ts` — public exports/compatibility debt |
| S03 | `packages/core/src/agent/mode/run-agent.ts` — modes, maxTurns, runTurn dispatch |
| S04 | `packages/core/src/composition/runtime/owner.ts` — teams retention, finishClose |
| S05 | `packages/core/src/composition/team/runtime.ts` — RuntimeTeamValue.sessions, close |
| S06 | `packages/core/src/composition/lifecycle/operations.ts`; `composition/agent/session.ts`; `agent/define/session.ts` — operation/session ownership |
| S07 | `packages/core/src/agent/loop/schedule.ts` — parallel segment, start, commit, result limits |
| S08 | `packages/core/src/agent/tool/pipeline.ts` — parse, authorize, dispatch, finalize, timeout |
| S09 | `packages/provider-http/src/base/http-adapter.ts`; `base/transport.ts` — transport security/cleanup/logging |
| S10 | `.github/workflows/ci.yml`; GitHub Actions run34005241091/job101411089799 — CI failure/skipped gates |
| S11 | `scripts/check-supply-chain.mts` — typed .mts, integrity/license/audit checks |
| S12 | `packages/core/src/agent/team/team.ts` — mailbox, disposal, limits |
| S13 | `tests/unit/composition/runtime-agent-team.spec.ts` — closed-component reporting and lifecycle tests |
| S14 | `packages/core/src/composition/agent/session.ts` — projectEvent full result envelope |
| S15 | `packages/mcp/src/client/http-security.ts`; `api-types.ts` — URL policy, defaults, validation |
| S16 | `tests/unit/mcp-http-security.spec.ts` — redirects and cross-origin credential stripping |
| S17 | `packages/core/src/agent/history/history.ts` — append-only log and snapshots |
| S18 | `packages/core/src/agent/history/config.ts` — history default limits |
| S19 | `packages/core/src/agent/accounting/event-buffer.ts` — event count/byte cap |
| S20 | `packages/core/src/composition/agent/types.ts` — public limits/session API |
| S21 | `packages/skill-filesystem/src/provider/filesystem-provider.ts`; package README — discovery, resource containment, YAML parser |
| S22 | `packages/core/src/composition/memory/key.ts` — fixed/tuple memory scope |
| S23 | `packages/core/src/composition/memory/run.ts` — load/commit expectedRevision, abort checks |
| S24 | `pnpm-workspace.yaml` — exact catalog, release-age/build policy and type versions |
| S25 | `tests/unit/composition/runtime-agent-policy.spec.ts` — provider fixture and callback capture tests |
| S26 | `packages/core/src/agent/tool/registry.ts`; `agent/tool/definition.ts` — registry/schema, raw value/render và cooperative cancellation contract |
| E01 | Node.js official release notes, v22.18.0, 31/07/2025 — default TypeScript stripping |
| E02 | Node.js official Process/CLI documentation — unhandled Promise rejection semantics |
| E03 | OWASP SSRF Prevention Cheat Sheet — DNS/IP and application/network controls |
| E04 | YAML official specification1.2.2, sections3.2.3.3/6.6 — comments do not change representation |

**Kết luận cuối:** giữ hướng kiến trúc, chưa bật production. Sửa những failure paths đã chỉ rõ, thống nhất security contract với host, rồi chứng minh bằng CI và kiểm thử vận hành của đúng SHA sẽ merge.
