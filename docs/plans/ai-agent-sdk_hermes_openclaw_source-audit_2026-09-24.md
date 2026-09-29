# Rà soát mã nguồn ai-agent-sdk, Hermes Agent và OpenClaw

> **Trạng thái cuối 27/09/2026:** implementation trong phạm vi đã chọn và các lượt kiểm chứng đã hoàn tất; xem [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Original SDK/final bundle đã chạy hai model, matched Việt/Anh, 5 repeats, independent prose review và raw-loss audit. PTC Codex đạt gate cho FILTER/JOIN; ZenMux giữ kết luận `no-go / needs-review`. SP-02 là host sample; SP-03–05/public package và Q4 giữ quyết định có điều kiện. Các trạng thái, điểm số và gate mở bên dưới là lịch sử tại thời điểm ghi, được giữ để audit. Không có superiority, USD savings hoặc production-validation claim.
## Những cơ chế nên chuyển giao — những phần đã có — những điều chưa đủ bằng chứng

**Ngày rà soát:** 24/09/2026  
**Hình thức:** phân tích tĩnh các đường code và test được liệt kê ở cuối tài liệu.  
**Đối tượng:** người phát triển `alvin0/ai-agent-sdk`.  
**Phạm vi thay đổi:** đề xuất kỹ thuật; không chỉnh sửa repository, không tạo pull request.

> **Kết luận chính:** Không nên biến ai-agent-sdk thành bản sao của Hermes hoặc OpenClaw. SDK đã có nhiều điểm mở rộng mà đánh giá trước bỏ sót: execution backend, nhật ký thao tác có tác dụng phụ, lưu approval, chọn model riêng cho compaction và quản lý team. Phần nên chuyển giao là các cơ chế cụ thể quanh những điểm mở rộng đó, kèm test hành vi; không phải thêm lại một tầng framework.
>
> **Một thay đổi lớn trong kết luận:** Với lập trình gọi tool theo chương trình, OpenClaw hiện có **Code Mode bằng JavaScript**. Đây là nguồn tham khảo trực tiếp cho SDK TypeScript, bên cạnh Python PTC của Hermes. Không còn đúng khi xem đây gần như chỉ là thế mạnh riêng của Hermes. [S01] [S02] [S04] [S05] [S06] [O02]

---

## Mục lục

1. [Tóm tắt quyết định](#1-tom-tat)
2. [Phạm vi, phiên bản và độ chắc chắn](#2-pham-vi)
3. [Đính chính đánh giá trước](#3-dinh-chinh)
4. [Ba kiến trúc thực sự đang giải quyết gì](#4-kien-truc)
5. [Những nền tảng SDK đã có](#5-sdk-da-co)
6. [Chuyển giao execution environment, không tạo lại execution backend](#6-execution)
7. [Chuyển giao programmatic tool calling](#7-program)
8. [Chuyển giao recall có nguồn gốc và phạm vi](#8-recall)
9. [Chuyển giao vòng đời skill có kiểm soát](#9-skill)
10. [Chuyển giao quyền sở hữu tác vụ và kết quả nền](#10-runner)
11. [Những gì nên giữ, không nên sao chép](#11-khong-copy)
12. [Cấu trúc triển khai tối thiểu](#12-trien-khai)
13. [Kế hoạch spike và đo hiệu quả](#13-spike)
14. [Ma trận kiểm thử chấp nhận](#14-tests)
15. [Thứ tự thực hiện và điều kiện dừng](#15-roadmap)
16. [License và cách chuyển mã](#16-license)
17. [Những câu hỏi vẫn cần xác minh](#17-chua-xac-minh)
18. [Danh mục bằng chứng đã đọc](#18-sources)
19. [Kết luận cuối](#19-ket-luan)

---

<a id="1-tom-tat"></a>
## 1. Tóm tắt quyết định

### 1.1. Năm kết luận có ảnh hưởng trực tiếp đến roadmap

**Thứ nhất, dừng đề xuất tạo mới `ToolExecutionBackend` và `ToolExecutionStore`.** Hai contract này đã có trong `packages/core/src/agent/tool/execution.ts`, cùng interceptor gắn chúng vào pipeline. Có test cho tái sử dụng kết quả, xung đột operation ID, lỗi commit sau side effect và backend từ xa. Công việc còn lại, nếu ứng dụng cần, là hiện thực adapter và kiểm chứng semantics của adapter. [S02] [S03]

**Thứ hai, chưa nên xếp auto-learning/curator vào P0.** Hermes có các cơ chế bảo vệ ownership và read-before-write đáng học; OpenClaw có review fork và giới hạn proposal. Tuy nhiên, những đường code này chứng minh cách quản lý thay đổi skill, không tự chứng minh rằng skill mới làm agent giải quyết công việc tốt hơn. Với SDK, nên đi từ lưu đề xuất có nguồn gốc đến đánh giá, rồi mới cho phép tự động phát hành. [H04] [H05] [H06] [O05] [O06]

**Thứ ba, PTC đáng làm một spike riêng, không phải thêm một hàm `eval`.** OpenClaw đã xử lý catalog gọi được, trì hoãn schema, tham chiếu dữ liệu lớn và continuation. Hermes cho thấy cách giữ dữ liệu trung gian ngoài context bằng RPC. Nhưng SDK phải bảo toàn cả scheduler, budget, checkpoint, trace và hậu kiểm, chứ không chỉ gọi `tool.execute()`. [O02] [O03] [H02] [H03] [S10] [S11]

**Thứ tư, recall là lớp tra cứu mới, không thay thế snapshot/task memory.** Một snapshot dùng để mở lại một cuộc hội thoại; một index dùng để tìm bằng chứng từ những cuộc hội thoại khác. Những cơ chế đáng học là phân biệt lineage, giới hạn excerpt, trạng thái xóa/thu hồi, nguồn dữ liệu và quyền truy xuất. [S07] [S08] [H07] [O07] [O08]

**Thứ năm, tác vụ nền cần một chủ thể chịu trách nhiệm nhận và lưu kết quả.** Hermes phân biệt khả năng lưu kết quả với khả năng đánh thức agent; OpenClaw chặn lifecycle event cũ ghi đè owner mới. SDK đã có team trong tiến trình và operation journal, nên phần mở rộng cần tập trung vào ownership qua restart và kênh nhận kết quả, không xây lại team. [H09] [O11] [S02] [S06]

### 1.2. Khuyến nghị chuyển giao sau khi sửa lại hiểu biết

| Hạng mục | Nên học chủ yếu từ đâu | Hình thức chuyển giao | Điều kiện mới cần làm |
|---|---|---|---|
| Môi trường chạy lệnh và vòng đời tài nguyên | Hermes `BaseEnvironment`; OpenClaw `SandboxBackendHandle` | Adapter trên contract SDK hiện có; lấy test cases và semantics | Cần local/container/remote execution dùng chung, có cancellation/cleanup rõ ràng |
| JavaScript gọi tool theo chương trình | OpenClaw Code Mode; Hermes RPC/output spill | Spike controller + executor tùy chọn + nested-call admission | Có workload nhiều bước xử lý dữ liệu mà đọc mọi kết quả qua LLM gây lãng phí |
| Tìm lại hội thoại và bằng chứng | Hermes session search; OpenClaw memory corpus/provenance | Extension read-only, scope do host cấp, index tùy chọn | Có nhu cầu truy hồi khác conversation; snapshot không giải quyết được |
| Skill proposal và quản lý phiên bản | Hermes guards/curator; OpenClaw review fork | Writer capability riêng, proposal store và kiểm định | Đã có nhiều workflow lặp lại và tập bài kiểm tra đại diện |
| Durable task ownership/result inbox | Hermes background routing; OpenClaw lifecycle fencing | Runner tùy chọn, tận dụng snapshot và tool journal hiện có | Cần tiếp tục công việc sau khi request hoặc process gốc kết thúc |

Đây là **ưu tiên thiết kế có điều kiện**, không phải bảng xếp hạng hiệu năng ba sản phẩm. Nguồn cho các cơ chế ở bảng: [S02] [H08] [O10] [H03] [O02] [H07] [O08] [H06] [O05] [H09] [O11].

---

<a id="2-pham-vi"></a>
## 2. Phạm vi, phiên bản và độ chắc chắn

### 2.1. Cố định commit, không trộn các phiên bản `main`

| Repository | Nhánh được lấy làm điểm bắt đầu | Commit dùng để đọc code |
|---|---|---|
| `alvin0/ai-agent-sdk` | `main` | `5b589b6abe6d0a61da3f55b549713456ccc8c7c4` |
| `NousResearch/hermes-agent` | `main` | `35b14ad5e24137b836d5c47c21a50c6ea7aeb785` |
| `openclaw/openclaw` | `main` | `8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a` |

Tất cả nguồn `[Sxx]`, `[Hxx]`, `[Oxx]` ở cuối tài liệu trỏ vào các commit này. Trong lúc tìm đường dẫn, kết quả tìm kiếm có thể đã trỏ sang commit mới hơn; những file dùng làm bằng chứng đều được mở lại ở commit đã cố định. Tài liệu không tự áp dụng kết luận cho mọi release/npm version.

### 2.2. Bốn loại bằng chứng

| Nhãn | Ý nghĩa | Không có nghĩa là |
|---|---|---|
| `CODE` | Đã đọc code ở phạm vi dòng ghi trong danh mục | Toàn repository đã được audit; mọi nhánh chạy đều được thử |
| `TEST-READ` | Đã đọc thiết lập, thao tác và assertion của test | Test đã được chạy hoặc pass trong môi trường hiện tại |
| `DOC` | Đã đọc tài liệu chính thức của đúng snapshot | Hành vi được chứng minh nếu implementation chưa được xem |
| `ĐỀ XUẤT` | Thiết kế tổng hợp dành cho SDK | API đã tồn tại, code đã compile hoặc thay đổi đã được triển khai |

**Không chạy bộ test upstream, không thực hiện benchmark LLM, không triển khai sandbox/container thực tế trong lần rà soát này.** Vì vậy không có kết luận “SDK an toàn hơn”, “tiết kiệm X% token”, “chạy tốt hơn model/harness khác” hay “đã production-ready”.

Phạm vi được chọn theo đường thực thi liên quan trực tiếp đến chuyển giao: tool pipeline/execution, session/memory, team, skill lifecycle, code execution, backend lifecycle và outcome ownership. Những file lớn được đọc theo đoạn; phần chưa đọc không được xem là đã kiểm chứng. Danh mục cuối tài liệu ghi rõ phạm vi này.

### 2.3. Cách đọc các phát biểu về khoảng trống

“Chưa xác nhận một API đóng gói” khác với “repository không có tính năng đó ở bất kỳ đâu”. Ví dụ, rule approval có test ở sample, dù không phải một policy engine generic trong public core. Tương tự, một queue mang tên `scheduler` có thể phục vụ xuất telemetry chứ không phải cron chạy agent. [S14] [S15]

Với PTC và cross-session recall, tài liệu chỉ khẳng định rằng **các public contract và đường session/tool đã đọc chưa đủ để xác nhận một feature hoàn chỉnh tương đương**. Trước khi thêm package mới, phải kiểm tra lại exported surface và các sample liên quan. Không dùng kết quả tìm kiếm rỗng để chứng minh tính năng không tồn tại.

---

<a id="3-dinh-chinh"></a>
## 3. Đính chính đánh giá trước

| Nhận định trước | Kết quả đọc lại | Hệ quả đối với đề xuất |
|---|---|---|
| SDK chưa có execution backend abstraction | Có `ToolExecutionBackend`, capabilities và `createToolExecutionInterceptor`. [S02] | Không tạo abstraction trùng; bổ sung adapter cụ thể khi cần |
| Cần thêm store để chống chạy lại side effect | Có `ToolExecutionStore`, claim/completed/unknown và conflict detection. [S02] [S03] | Tập trung vào adapter durable và reconciliation, không viết lại contract |
| SDK mới chỉ có approval trong một call, chưa có persistence | Có `withApprovalPersistence` và `ApprovalStateStore`; lưu pending/decision. [S04] | Phân biệt lưu quyết định với policy cho phép tái sử dụng quyền |
| Chưa có persistent approval rule | Sample có command rule widths và test matching, kể cả key cũ. [S14] | Trước tiên đánh giá khả năng tách phần sample thành extension; không mặc định copy OpenClaw |
| Compaction buộc dùng model chính | Có `summarizationProvider`, `summarizationModel`, `summarizationEffort`. [S05] | Không cần model-purpose router chỉ để giảm chi phí compaction |
| Worker steer/dependency lifecycle còn thiếu | Managed team có `.steer()`, dependency options, write-scope options và vòng đời worker. [S06] | Chỉ bổ sung phần ownership/delivery qua restart thực sự thiếu |
| OpenClaw chủ yếu là gateway | Có `runEmbeddedAgent` và orchestration cho session/global lanes, admission và runtime generation. [O01] | Không dùng “gateway vs runtime” làm kết luận kỹ thuật tuyệt đối |
| PTC gần như chỉ đáng học từ Hermes | OpenClaw có JavaScript Code Mode, tool catalog, bridge và result handles. [O02] [O03] | Đối với TS SDK, OpenClaw trở thành nguồn tham khảo chính của phần này |
| OpenClaw mặc định có người duyệt skill | Config tại commit đọc có `autonomous.mode: "auto"` và `approvalPolicy: "auto"`. [O06] | Không được suy ra governance bắt buộc từ việc có proposal mode |
| Hermes pinned skill không thể chỉnh sửa | Foreground `_pinned_guard` chặn deletion nhưng cho edit/patch; background review có guard chặt hơn. [H06] | Phải phân biệt actor, action và chế độ, không chỉ một cờ pinned |
| Cứ thêm package thì không cần chạm integration core | PTC đi vào khác cấp của scheduler/accounting/history. [S10] [S11] | Có thể cần một điểm nối nhỏ dùng chung; phải spike trước khi chốt “không đụng core” |
| SDK có sandbox tốt hơn Hermes/OpenClaw | Chưa có kiểm thử đối chứng cùng threat model; SDK còn phân biệt partial/full/fence-only và trường hợp không hỗ trợ. [S13] | Rút kết luận xếp hạng; giữ đánh giá theo năng lực cụ thể và giới hạn |

Những đính chính này không phải thay tên package trong kế hoạch cũ. Chúng làm thay đổi khối lượng công việc: **ít xây mới hơn, nhiều kiểm tra đường tích hợp và semantics hơn**.

---

<a id="4-kien-truc"></a>
## 4. Ba kiến trúc thực sự đang giải quyết gì

### 4.1. ai-agent-sdk: các điểm nối để host sở hữu policy và hạ tầng

Các đường đã đọc thể hiện cấu trúc sau:

```text
AgentSession
  ├─ state: history, memory, skill activation, conversation identity
  └─ turn execution
       └─ runTurn
            └─ runToolCalls
                 ├─ prepareToolCall
                 ├─ authorizeToolCall
                 ├─ checkpoint trước dispatch
                 ├─ dispatchAuthorizedToolCall
                 │    └─ interceptors.around
                 │         └─ ToolExecutionBackend / ToolExecutionStore
                 └─ finalizeToolCall
                      └─ xuất bản kết quả theo scheduler
```

Session quản lý state; pipeline quản lý một tool call; scheduler quản lý quan hệ giữa nhiều call, budget và các event/checkpoint liên quan. Execution interceptor là điểm gắn backend và operation journal, không phải sự thay thế scheduler. [S08] [S10] [S11] [S12] [S02]

Đặc biệt, `dispatchToolCall()` được chú thích là compatibility facade cho caller không cần scheduling. Bởi vậy, đề xuất “chạy PTC bằng cách gọi lại `dispatchToolCall`” mới giải được **một phần** bài toán. [S10]

### 4.2. Hermes: application runtime với nhiều vòng đời gắn vào môi trường thực thi

Trong snapshot này, vòng hội thoại đã tách ra `agent/conversation_loop.py`, gọi các phase `turn_*`; không nên chỉ nhìn `run_agent.py` hoặc một tên hàm cũ để đánh giá. Code có các guard cho pressure của context, lượt review phụ, thời gian chạy và trạng thái sau compaction. [H01] [H12]

Các đường liên quan nhất:

```text
Conversation turn
  ├─ model request / retry / response / tool-round / finalization phases
  ├─ execute_code
  │    └─ Python guest → RPC → handle_function_call
  ├─ session_search → DB messages / lineage / bounded excerpts
  └─ delegate_task dispatch
       └─ origin owner + khả năng nhận kết quả + child completion recording

Application maintenance
  └─ curator → deterministic lifecycle → optional consolidation
```

Hermes đáng học ở cách gắn năng lực vào vận hành thực tế: môi trường có trạng thái, process cleanup, kết quả lớn phải đọc lại thay vì chạy lại, review tách khỏi hội thoại chính, và khác biệt giữa phiên có/không có nơi nhận kết quả nền. Những cơ chế này không nhất thiết phải nằm trong SDK core. [H02] [H03] [H04] [H07] [H08] [H09]

### 4.3. OpenClaw: runtime agent tích hợp cộng với nhiều lớp quản lý ứng dụng

`runEmbeddedAgent` không chỉ chuyển một message sang service bên ngoài. Trong đoạn code đọc được, nó giải quyết config, lifecycle generation, admission, session identity, session lane, global lane, maintenance và prepared runtime. Có nhánh dùng CLI backend đủ điều kiện, nhưng nhánh này vẫn đi qua admission/lifecycle liên quan. [O01]

Các module được đọc cho thấy:

```text
Embedded run admission
  ├─ session/global scheduling
  ├─ captured runtime generations
  ├─ code mode / tool bridge
  └─ lifecycle persistence với writer/revision checks

Optional/application subsystems
  ├─ memory corpus + artifact provenance
  ├─ skill experience review
  └─ sandbox backend factory + reserved runtime handle
```

Vì vậy, không có cơ sở để xếp OpenClaw thấp hơn về “agent loop” chỉ vì có gateway lớn. Điều có thể nói từ code là **nó giải quyết thêm nhiều ownership concern ở mức application**, dẫn tới nhiều module và dependency không phù hợp để bê nguyên vào SDK. [O01] [O09] [O11]

### 4.4. So sánh đúng cấp

| Cấp | SDK hiện có | Nguồn tham khảo hữu ích | Không được đánh đồng |
|---|---|---|---|
| Một call | Tool pipeline + execution interceptor | RPC/tool bridge | Một call chạy được ≠ toàn workflow được tính budget |
| Một conversation | Session snapshot + memory binding | Recall, lifecycle generation | Snapshot ≠ kho tìm kiếm toàn bộ lịch sử |
| Nhiều agent đang sống | Managed team | Background completion routing | Promise đang chạy ≠ task tồn tại qua process crash |
| Môi trường thực thi | Policy/confine và generic backend seam | Environment handle/provision/cleanup | `read-only` file policy ≠ không có tác dụng phụ mạng/service |
| Ứng dụng chạy lâu dài | Host tự gắn phần còn lại | Gateway/runner/task ownership | SDK ≠ một personal assistant hoàn chỉnh |

Các cột hiện trạng và nguồn tham khảo dựa trên [S02] [S06] [S07] [S08] [S10] [S11] [S13] [H07] [H08] [H09] [O09] [O10] [O11].

---

<a id="5-sdk-da-co"></a>
## 5. Những nền tảng SDK đã có: phải dùng trước khi thêm mới

### 5.1. Execution backend và operation journal

`ToolExecutionBackend` có `id`, `capabilities` và `execute(request, local)`. Request chứa operation ID, tool name, args, identity do host cung cấp và signal. `ToolExecutionStore` có thao tác claim và complete; claim có thể trả về mới nhận, đã hoàn thành hoặc outcome chưa xác định. [S02]

Điểm đáng giữ là cách xử lý lỗi ở ranh giới side effect:

| Tình huống | Hành vi được hiện thực/test mô tả |
|---|---|
| Operation đã hoàn thành, process mới đọc lại | Tái sử dụng kết quả đã lưu, không chạy handler lần nữa |
| Cùng operation ID nhưng args/identity/operation khác | Từ chối bằng `OPERATION_ID_CONFLICT` |
| Side effect chạy xong nhưng commit kết quả lỗi | Lần sau gặp `OPERATION_OUTCOME_UNKNOWN`, không tự chạy lại |
| Hai claimant đồng thời | Store phải cấp claim độc quyền; test chỉ cho một bên thực thi |
| Backend từ xa trả dữ liệu nhạy cảm | Post-policy vẫn có thể thay toàn bộ envelope, không chỉ text |

Nguồn: implementation [S02] và các assertion [S03]. **Đây là test đã đọc, chưa chạy trong lần rà soát.**

Điểm giới hạn cũng quan trọng: contract không làm mọi backend tự nhiên có exactly-once semantics. Chất lượng của atomic claim, durability và reconciliation phụ thuộc store/backend thực tế. Một `Map` trong test không chứng minh multi-process safety của SQLite/PostgreSQL adapter.

**ĐỀ XUẤT:** ưu tiên một bộ conformance test chung cho backend/store thay vì viết contract khác tên. Đưa các failure window ở bảng trên thành yêu cầu bắt buộc cho mọi adapter durable.

### 5.2. Approval đã có identity và journal

Trong code đọc lại, approval request được SDK tạo với identity riêng; broker kiểm tra request đã được cấp và chưa sử dụng. Pending waiter được cài trước khi phát event để không làm mất quyết định được UI trả ngay. `withApprovalPersistence` lưu pending và decision, nhưng không tự coi decision cũ là quyền mới sau recovery. [S04] [S10]

Ba khái niệm cần tách:

```text
Approval journal:      đã hỏi ai, hỏi gì, trả lời thế nào?
Reusable policy rule:  một hành động tương lai có nằm trong quyền cho phép không?
Execution authority:   lần thực thi hiện tại có được host cho phép ngay lúc này không?
```

Sample đã có test phân biệt grant `git diff` với `git push`, đường dẫn `./git` với bare `git`, và không đề xuất permanent rule cho shell chain. Vì thế, SDK không phải bắt đầu từ số không khi muốn đóng gói policy rule. [S14]

**ĐỀ XUẤT:** trước khi học rule engine từ OpenClaw, kiểm tra phần sample nào có thể tách ra mà không kéo UI/database vào core. Một permanent rule phải được đánh giá lại với identity, workspace và policy hiện tại; không serialize một approval capability rồi tái sử dụng vô hạn.

### 5.3. Compaction đã có lựa chọn model riêng

`AgentCompactionOptions` đã hỗ trợ `summarizationProvider`, `summarizationModel`, `summarizationEffort`; provider và model được validate theo cặp. Những trường này trực tiếp đáp ứng trường hợp dùng model khác cho nén ngữ cảnh. [S05]

**ĐỀ XUẤT:** dùng API hiện tại và đo trước. Chỉ thêm purpose router nếu sau đó có ít nhất nhiều loại công việc phụ thật sự cần chung một cơ chế chọn model. Không thêm router vì một use case đã giải được.

Model nhỏ hơn không mặc nhiên tốt hơn về tổng chi phí: summary kém có thể khiến lượt sau phải đọc lại dữ liệu hoặc làm lại việc. Chỉ số cần đo là tổng chi phí để đạt đầu ra đúng, không chỉ chi phí một lần compaction.

### 5.4. Team đã có orchestration trong tiến trình

`managed.ts` có worker lifecycle, khởi tạo worker, task dependencies, write-scope options, điều hướng lead và `.steer()`. Những phần này đủ để bác bỏ đánh giá rằng SDK mới có “gửi message giữa agent” mà chưa có manager/worker. [S06]

Tuy nhiên, options `writes` hoặc khả năng phát hiện xung đột được khai báo **không đồng nghĩa với OS ngăn hai process ghi cùng một file**. Muốn có cam kết đó phải kiểm tra backend và mount/workspace thực tế. Tương tự, map/promise trong managed team không tự sống lại sau process crash. [S06] [S13]

**ĐỀ XUẤT:** giữ team API; bổ sung một lớp runner ngoài core khi cần external task ownership. Không thêm một subagent framework song song.

### 5.5. Session persistence khác recall, task queue và telemetry delivery

Session có snapshot/resume/reset và identity; memory store có revision và commit với expected revision. Đây là nền để host lưu state có kiểm soát, không phải database index tìm kiếm liên conversation. [S07] [S08]

Test `delivery-queue-scheduler.spec.ts` làm việc với `ObservationDeliveryBatch`, event IDs, run records và acknowledgment của exporter. Nó kiểm tra việc gửi telemetry có thể required/best-effort, partial ack và seal. **Không được lấy tên `DeliveryQueueScheduler` để kết luận SDK đã có hoặc chưa cần cron/task scheduler.** Hai bài toán khác nhau. [S15]

---

<a id="6-execution"></a>
## 6. Chuyển giao execution environment, không tạo lại execution backend

### 6.1. Hermes thực sự bổ sung những gì

`BaseEnvironment` có mô hình một process shell mới cho mỗi command, cùng state cho CWD/snapshot môi trường. Phần đã đọc có giao diện `_run_bash`, `cleanup`, `fetch_file`, cờ `is_local`, lớp lỗi kết nối và cơ chế theo dõi process đang chạy để xử lý shutdown. [H08]

Điều đáng học không phải “có nhiều tên backend”, mà là các câu hỏi được biến thành contract:

- Môi trường nào sở hữu CWD và file?
- Ai kết thúc cây process khi host đóng?
- Lỗi do command exit khác lỗi do SSH/container service không tới được thế nào?
- Đọc artifact từ môi trường xa có giới hạn byte ở phía nào?
- Một môi trường đã hết vòng đời còn có được nhận lệnh mới không?

**Không bê nguyên shell/environment snapshot.** SDK có thể không muốn thừa hưởng alias, shell startup hoặc biến môi trường từ máy developer. Đó phải là policy tường minh của adapter, không phải tiện ích mặc định.

### 6.2. OpenClaw bổ sung một góc nhìn khác: authority của runtime handle

`SandboxBackendExecSpec` tách `cwd` của local transport khỏi workdir ở remote. Handle có thể validate workdir, chuẩn bị spec thực thi, finalize kết quả và cấp cleanup chỉ dùng để kết thúc process. `assertCurrent` cho phép kiểm lại authority ở thời điểm launch bị trì hoãn. [O10]

Registry backend có generation/retirement và đường reserve runtime ID. Nó kiểm tra backend trả về đúng runtime đã được cấp, thay vì chỉ tin một chuỗi tên container. Các disposer cũ không được làm sống lại generation đã retired. [O09]

**Cơ chế nên chuyển giao:** “handle sống có owner, bị thu hồi được, và phải được kiểm lại trước side effect”. Không chuyển `globalThis` registry hoặc toàn bộ plugin/runtime graph của OpenClaw vào SDK.

### 6.3. Ghép vào SDK hiện tại

**ĐỀ XUẤT — sơ đồ tích hợp, không phải API mới đã có:**

```text
SDK tool scheduler/pipeline
  → createToolExecutionInterceptor
      → adapter thực thi ToolExecutionBackend
          → execution environment được host cấp
              → local: confine(argv, policy) rồi spawn an toàn
              → container/remote: adapter-specific launch và enforcement
```

`SandboxProvider.confine()` vẫn chỉ tạo argv/profile; nó không trở thành executor. Với tool làm file I/O ngay trong process, `fence()` là một lớp khác. Source hiện tại chủ động từ chối kernel confinement cho `baseline: deny` vì chưa xây allowlist môi trường khởi động tương ứng; adapter không được “giải quyết” bằng cách bỏ policy và chạy local. [S13]

**Một API phác thảo tối thiểu để thảo luận — chưa được triển khai/compile:**

```ts
// ĐỀ XUẤT: chỉ là options của một optional adapter, không thay contract core.
interface ProcessBackendOptions {
  environment: ProcessEnvironment;
  policy: HostExecutionPolicy;
  requirements: ExecutionRequirements;
}

// Kiểu kết quả phải là ToolExecutionBackend hiện có của SDK.
// ProcessEnvironment/HostExecutionPolicy/ExecutionRequirements là kiểu đề xuất.
declare function createProcessToolExecutionBackend(
  options: ProcessBackendOptions,
): ToolExecutionBackend;
```

Không cần chốt ngay một `ProcessEnvironment` hàng chục method. MVP chỉ nên có acquire/execute/release và artifact read có giới hạn nếu workload cần. Interactive PTY, upload, nhiều mount, persistent shell và hibernation là các capability riêng, không phải mặc định bắt buộc.

### 6.4. Những yêu cầu không được bỏ qua

| Ranh giới | Yêu cầu đề xuất |
|---|---|
| Cấu hình → thực thi | Kiểm tra backend thực tế đáp ứng capability yêu cầu; thiếu thì từ chối |
| Approve → launch | Kiểm tra lại generation, workspace và identity sau mọi khoảng chờ |
| Cancel → cleanup | Báo được đã gửi hủy, đã xác nhận process dừng, hay outcome vẫn chưa rõ |
| Remote disconnect | Không tự retry command có side effect chỉ vì mất kết nối |
| Backend fallback | Không tự chuyển sandbox/container sang host execution |
| Output/artifact | Đọc có giới hạn, có trạng thái truncated, có reference để đọc tiếp |
| Host identity → guest | Không cho model tự chọn tenant, principal hoặc credential context |

Các yêu cầu là tổng hợp thiết kế từ [S02] [S13] [H08] [O09] [O10], không phải tuyên bố mọi backend upstream đã bảo đảm toàn bộ.

### 6.5. Tiêu chí chấp nhận

Một conformance suite phải chạy cùng logic trên adapter local và adapter remote/container được chọn: command thành công; nonzero exit; timeout; abort khi đang khởi tạo; mất kết nối sau dispatch; đóng host khi child còn chạy; output lớn; handle retired; artifact quá giới hạn; cleanup nhiều lần.

Bảng capabilities chỉ là lời khai của backend. Cần bài test thật trên nền tảng triển khai để chứng minh mức enforcement; unit test fake backend không thể làm việc đó.

---

<a id="7-program"></a>
## 7. Chuyển giao programmatic tool calling

### 7.1. Bài toán cụ thể

Một workflow có thể đọc danh sách, đọc từng item, lọc, nối dữ liệu rồi trả vài kết quả cuối. Cách thông thường đưa từng kết quả trung gian về LLM. PTC cho chương trình xử lý các bước cơ học đó, chỉ gửi lại phần thật sự cần reasoning.

Đây là lợi ích kiến trúc tiềm năng, **chưa phải kết quả tiết kiệm token đã đo trên SDK**.

### 7.2. Cơ chế Hermes đã đọc

`execute_code` sinh các stub Python chỉ cho tập tool được phép và đang enabled. RPC kiểm token, tool allowlist và số call, rồi dispatch về `handle_function_call`; các tham số terminal tạo process nền bị loại khỏi đường RPC này. Output có giới hạn, metadata về phần bị cắt và đường dẫn spill để đọc lại. [H02] [H03]

Các bài học có thể port trực tiếp về semantics:

| Cơ chế | Giá trị cho SDK |
|---|---|
| Tập tool của guest là giao của enabled và allowlist | Guest không tự mở rộng tool catalog |
| RPC token riêng | Phân biệt guest được cấp quyền với request khác tới bridge |
| Giới hạn số call | Một lần execute không che giấu vòng lặp vô hạn gọi tool |
| Output spill có reference | Không chạy lại thao tác chỉ vì stdout bị cắt |
| Foreground-only terminal qua bridge | Không tạo worker/process mồ côi từ một chương trình có vòng đời ngắn |

Nhưng kiểm token và environment scrubbing không chứng minh Python guest bị cô lập khỏi OS. Có tool bridge an toàn hơn không đồng nghĩa mọi thao tác Python trực tiếp cũng bị kiểm soát. Không chuyển chữ “sandbox” trong tên biến thành cam kết security.

### 7.3. OpenClaw là nguồn tham khảo JavaScript cụ thể

`src/agents/code-mode.ts` có controller cho JavaScript, một catalog index giới hạn kích thước, tool globals bất đồng bộ, schema đọc theo nhu cầu, và hướng dẫn sử dụng output schema đã khai báo. Với output chưa biết, agent được hướng dẫn không đoán field để lập tiếp một chuỗi thao tác trong cùng cell. [O02]

Đây là insight thực dụng: một chương trình gọi tool rất dễ hỏng nếu model đoán sai schema đầu ra. Có input schema chưa đủ; cần output contract hoặc một bước inspect rõ ràng.

OpenClaw cũng có result handles: lưu object lớn, trả descriptor, rồi load/delete trong phạm vi được quản lý. Trong bridge đã đọc, nguồn network của dữ liệu được ghi khi save và truyền lại khi load; lưu qua result store không tự rửa bỏ nguồn gốc. [O02] [O03]

**Nên học:** catalog callable nhưng trì hoãn schema; results-as-handles; continuation có owner; provenance đi cùng dữ liệu; tool result nguyên vẹn trong chương trình phải tuân thủ giới hạn rõ, không âm thầm dùng JSON bị cắt.

**Không nên bê ngay:** toàn bộ Swarm, nodes, channel routing, plugin registry hoặc mọi namespace của OpenClaw. Những thứ đó không cần thiết để SDK có PTC cho một tool catalog nhỏ.

### 7.4. Node VM không phải sandbox an toàn

Tài liệu executor chính thức tại snapshot này nói rõ: Node Code Mode mặc định sử dụng `node:vm` trong worker thread, dùng quyền OS của process gateway; worker giúp tách computation khỏi event loop nhưng không phải security boundary. QuickJS là một lựa chọn guest khác, vẫn chịu quyền các tool mà host cấp. Tài liệu cũng mô tả continuation của cả hai là transient, không sống qua gateway restart. Đây là thông tin `DOC`, không phải kết quả pentest trong báo cáo. [O04]

Test QuickJS được đọc có fixture tạo VM/snapshot thật và kiểm trạng thái được tiêu thụ qua resume; điều đó hữu ích để thiết kế lifecycle test. Nó **không** chứng minh một durable task có thể tự sống lại sau process crash. [O12]

**ĐỀ XUẤT cho SDK:**

- Không cung cấp `eval`/`new Function`/`node:vm` rồi gọi đó là hostile-code isolation.
- Executor phải do host chọn, có capability/limits rõ; missing executor phải lỗi, không fallback sang host có quyền rộng hơn.
- Một adapter guest được cô lập và một adapter “trusted local program” có thể cùng tồn tại, nhưng tên và tài liệu phải nói đúng mức bảo vệ.

### 7.5. Khó khăn tích hợp thực sự: pipeline không phải scheduler

SDK chia hai lớp:

**Pipeline** chuẩn bị args, pre-policy, approval, around execution và post-policy. Post replacement tái dựng envelope, xóa cả raw value/meta/error/additional context cần loại; không chỉ đổi chuỗi gửi LLM. [S10]

**Scheduler** bổ sung dispatch limit, `maxParallel`, phân loại exclusive/parallel, trace, event, before-dispatch checkpoint, timeout và accounting. Nó xuất kết quả theo thứ tự, ngay cả khi phần body chạy song song. [S11]

Vì vậy, implementation như sau **không đạt yêu cầu**:

```ts
// KHÔNG NÊN: bỏ qua policy, approval, journal và vòng đời SDK.
await registry.get(name)!.execute(args, inventedContext);
```

Cách sau cũng **chưa đủ để tuyên bố hoàn chỉnh**:

```ts
// Có thể dùng làm building block, nhưng không tự mang theo toàn bộ
// dispatchLimit, parent accounting, trace và checkpoint của runToolCalls.
await dispatchToolCall(options);
```

**ĐỀ XUẤT:** tạo một quyền gọi tool con do host bind, dùng chung cơ chế admission/accounting với lượt chạy. Đừng dùng lại nguyên hàm scheduler nếu nó sẽ ghi mọi dữ liệu trung gian vào model-visible history; cần tách **nhật ký vận hành** khỏi **projection cho LLM**.

### 7.6. Flow đề xuất

```text
Model emits execute_program(code)
  → host chốt program identity + allowed tools + limits + owner
  → guest executor chạy code
  → mỗi tool call con:
       cấp call identity do host tạo
       kiểm cancellation/owner/budget
       prepare + policy + approval
       checkpoint / operation claim khi được cấu hình
       thực thi qua backend
       finalize/sanitize toàn envelope
       ghi trace + accounting + result receipt
       trả kết quả đã được phép cho guest
  → chương trình trả projection cuối hoặc result handle
  → LLM nhận projection có giới hạn; audit vẫn thấy các call con
```

**Các điểm dễ làm sai:**

1. **Budget bị nhân lên:** outer call được tính là 1 nhưng bên trong gọi 500 tool. Phải có ngân sách dùng chung và giới hạn riêng cho chương trình.
2. **Bỏ qua hậu kiểm:** guest nhận raw value trước sanitizer rồi in ra ngoài. Guest chỉ được nhận kết quả sau policy tương ứng.
3. **Deadlock khi lồng scheduler:** outer program giữ exclusive slot, child call lại đợi chính slot đó. Spike phải kiểm tra quyền sở hữu slot và concurrency contract.
4. **Nuốt lỗi side effect unknown:** code bắt mọi exception rồi retry. Trạng thái chưa rõ phải được giữ thành stop/reconcile phù hợp, không biến thành lời khuyên “thử lại”.
5. **Làm mất audit để giảm token:** giảm dữ liệu gửi LLM không có nghĩa bỏ child-call trace hoặc bỏ checkpoint.
6. **Capability cũ sau resume:** continuation phải gắn với owner và policy hiện tại, không giữ closure có quyền đã bị thu hồi.

Đây là các rủi ro thiết kế suy ra từ việc ghép các lớp [S02] [S10] [S11] với [H03] [O02] [O03]; không phải cáo buộc lỗ hổng đã tái hiện trong upstream.

### 7.7. MVP và điều kiện tiếp tục

MVP chỉ nên hỗ trợ read-only tools, một executor, JSON data, giới hạn call/output/runtime, không detached continuation, không subagent bên trong, không tạo cron, không credential passthrough. Sau khi đo chất lượng và budget parity mới mở mutation hoặc continuation.

Chỉ tiếp tục nếu chương trình cho đầu ra đúng ít nhất theo các acceptance case đã xác định, mọi call con đều thấy trong trace, không vượt quyền và tổng chi phí thực tế cải thiện ở workload mục tiêu. Không chốt một tỷ lệ tiết kiệm trước khi chạy benchmark.

---

<a id="8-recall"></a>
## 8. Chuyển giao recall có nguồn gốc và phạm vi

### 8.1. Giữ ba lớp khác nhau

```text
State của công việc đang làm       → session/task memory
Mở lại cùng cuộc hội thoại         → snapshot + memory binding
Tìm bằng chứng từ cuộc hội thoại khác → recall index + bounded read
```

Hai lớp đầu đã có nền trong SDK. Không cần thay `MemoryStore` bằng một vector database để có lớp thứ ba. [S07] [S08]

### 8.2. Hermes: những chi tiết hơn hẳn một hàm search đơn giản

`session_search_tool.py` phân biệt discovery, scroll quanh message anchor, read session và browse. Nó xem xét session lineage và compaction; hạ ưu tiên nguồn cron để lịch chạy lặp lại không lấn át hội thoại tương tác; giới hạn nội dung từng message thay vì chỉ giới hạn số message. [H07]

Một phân biệt đặc biệt nên học:

```text
active=0, compacted=1 → dữ liệu rời live context do nén; có thể là bằng chứng hợp lệ
active=0, compacted=0 → dữ liệu bị rewind/undo; không được coi như archive thông thường
```

Một hệ thống recall chỉ index “mọi transcript từng có” có thể vô tình làm sống lại nội dung người dùng đã thu hồi. Cần semantics riêng cho archive, superseded, undo, deleted và retention. [H07]

Test profile của Hermes tạo hai database có dữ liệu khác nhau, gọi tool qua inline executor với profile đích và kiểm trường hợp profile không tồn tại không rơi về default DB. Đáng học là test routing; **không được suy ra profile name do model đưa vào là một cơ chế phân quyền đa tenant đủ mạnh**. [H10]

### 8.3. OpenClaw: corpus thuộc quyền host, provenance ở ngoài văn bản

`memory-core/src/tools.ts` kiểm tra `corpus` bằng một enum đóng ngay trong code, không chỉ tin JSON schema provider. Runtime có thể ép corpus cho một recall context; args do model tạo không được tự mở rộng tập nguồn đó. [O07]

`memory-artifact-provenance.ts` lưu origin class, hash nội dung, thời điểm và session identity ở store riêng. Nó chuẩn hóa workspace thật, dùng reservation identity để rollback không ghi đè một writer mới, và giữ nguồn `untrusted` trong những trường hợp không có chuỗi nội dung tin cậy tương ứng. [O08]

Điểm nên chuyển giao không phải tên `MEMORY.md`, mà là:

> **Nguồn gốc và quyền sử dụng một mẩu nhớ phải nằm trong metadata do runtime quản lý; không lấy từ câu “đây là thông tin đáng tin” bên trong chính đoạn nhớ.**

### 8.4. Contract đề xuất tối thiểu

**ĐỀ XUẤT — chưa phải public API:**

```ts
interface RecallScope {
  // Host cấp sau xác thực; không đưa các trường này vào tool args.
  principalId: string;
  namespace: string;
  authorizationRevision: string;
}

interface RecallHit {
  reference: string;       // opaque reference; không phải đường dẫn tùy ý
  conversationId: string;
  messageId: string;
  sourceRevision: string;
  excerpt: string;
  truncated: boolean;
  provenance: RecallProvenance;
}

interface RecallIndex {
  search(scope: RecallScope, query: RecallQuery): Promise<RecallPage>;
  read(scope: RecallScope, reference: string, range: RecallRange): Promise<RecallExcerpt>;
}
```

`RecallProvenance`, `RecallQuery`, `RecallPage`, `RecallRange`, `RecallExcerpt` là các kiểu còn phải thiết kế; snippet chỉ mô tả ranh giới. Không mặc định schema này là tương thích trực tiếp với SDK.

**Yêu cầu:** cả `search` lẫn `read` phải kiểm quyền; không coi việc search từng trả một hit là quyền đọc vĩnh viễn. Reference phải gắn với revision/owner, có giới hạn số byte và thời gian. Tool chỉ nhận query/range hợp lệ, không nhận trusted identity tùy ý.

### 8.5. Indexing và lifecycle đề xuất

| Sự kiện | Hành vi mong muốn |
|---|---|
| Có transcript đã commit | Ghi index theo revision; không index token/chunk chưa ổn định |
| Conversation bị reset | Phân biệt reset context với yêu cầu xóa lịch sử; áp dụng policy đã định nghĩa |
| Message bị undo/thu hồi | Không trả lại chỉ vì nó còn trong append-only audit |
| Dữ liệu bị xóa | Tombstone hoặc delete lan tới keyword/vector/cache theo policy; search/read đều kiểm trạng thái |
| Quyền người đọc thay đổi | Hit cũ không được dùng để vượt quyền mới |
| Index chưa theo kịp | Trả staleness/partial khi cần; không nói “không có” khi mới tìm một phần |
| Worker/cron sinh quá nhiều log | Có source weighting/filter; không để chúng mặc định nuốt top results |

### 8.6. Bắt đầu keyword-first, không dựng RAG lớn ngay

Một adapter keyword/full-text đơn giản giúp kiểm chứng scope, deletion, pagination, citation và revision mà chưa phải xử lý thêm embedding drift. Sau đó mới thêm semantic/hybrid search nếu benchmark chứng minh keyword bỏ sót câu hỏi cần thiết.

Đây là lựa chọn triển khai đề xuất, không phải tuyên bố FTS luôn tốt hơn vector hoặc mọi workload chỉ cần FTS. SDK đã có embedding-related exports; không nên thêm một provider hệ thống độc lập chỉ cho recall nếu có thể dùng abstraction hiện hữu. [S01]

### 8.7. Điều recall không được làm

Nội dung được retrieve là **bằng chứng từ quá khứ**, không phải authorization để chạy lệnh hiện tại, không thay instruction của developer và không tự sửa objective. Một ghi chú cũ “đã cho phép restart” không phải approval mới cho lần restart hôm nay.

---

<a id="9-skill"></a>
## 9. Chuyển giao vòng đời skill có kiểm soát

### 9.1. SDK đã có mặt đọc tốt để gắn thêm, không cần thay provider

`SkillProviderPlugin` đã chia list catalog theo revision, load skill và read resource. Reference mang identity/source/provider/catalog revision. Mặt này là read-oriented; không nên thêm `write()` vào cùng object rồi mặc định agent nào đọc được cũng ghi được. [S09]

**ĐỀ XUẤT:** `SkillProposalStore`/`SkillMutationAuthority` là capability riêng, do host cấp cho một learner/reviewer cụ thể. Tên kiểu ở đây chỉ là gợi ý thiết kế.

### 9.2. Những gì nên học từ Hermes

Curator có hai nhóm công việc khác nhau. Đoạn code đã đọc mặc định bật curator nhưng **tắt LLM consolidation**; chuyển active/stale/archived theo hoạt động là deterministic. First observation seed mốc thời gian và chưa chạy ngay. Skill được cron tham chiếu được đưa vào tập protected ở đường bình thường. [H04]

Không nên copy sự “best effort” mà không xem tác động: trong đoạn đọc được, lỗi đọc cron references trả tập rỗng. Với SDK yêu cầu bảo vệ dependency nghiêm ngặt, **đề xuất fail closed hoặc bỏ qua archive pass khi không xác minh được references**, không coi “không đọc được” là “không ai sử dụng”. Đây là khuyến nghị khác với code upstream ở nhánh lỗi đó. [H04]

Guard của skill manager tách foreground/background. Background review bị hạn chế với pinned/external/bundled/hub/user-owned skills; provenance không đọc được bị từ chối ở ownership guard. Review phải đọc target trước khi ghi. Foreground pin chỉ ngăn deletion, không chặn mọi edit. [H06]

Skill manager cũng có lock theo skill và giới hạn tên, content, supporting files. Các lock của batch được lấy theo thứ tự ổn định. Scan cho agent-created skills là opt-in ở helper đã đọc; không được suy ra “skill nào agent tạo cũng đã vượt qua security scanner”. [H05]

### 9.3. Những gì nên học từ OpenClaw

Review có mode off/propose/auto. Code khởi tạo riêng review run, giới hạn tool set; proposal mode có mutation budget 1. Nó kiểm source session vẫn tồn tại, session identity và permission không thay đổi sau chuẩn bị bất đồng bộ, rồi kiểm lại ở thời điểm kết thúc. Foreground delivery capability không được dùng lại bởi review fork. [O05]

Đây là lesson quan trọng hơn “có người approve”:

> **Một review được bắt đầu hợp lệ vẫn có thể mất quyền trước khi ghi kết quả. Chỉ kiểm trước lúc gọi LLM là chưa đủ.**

Config mặc định thực tế là auto/auto. Do đó, cho SDK enterprise hoặc embedded generic, tài liệu **đề xuất một default khác**: learning tắt hoặc chỉ tạo proposal, không tự đổi skill đang active. Đó là lựa chọn thiết kế cho SDK, không phải mô tả default của OpenClaw. [O06]

### 9.4. Vòng đời đề xuất

```text
Task evidence đã commit
  → đề xuất skill mới / patch
  → lưu draft gắn baseRevision + evidenceRefs
  → validate cấu trúc, ownership, dependencies, giới hạn
  → kiểm thử hành vi / review
  → host quyết định publish
  → compare-and-swap revision
  → phát catalog revision mới cho lượt thích hợp
```

Không dùng “agent nghĩ rằng nó đã học được điều hữu ích” làm tiêu chí publish duy nhất.

### 9.5. Dữ liệu tối thiểu của một proposal

| Trường đề xuất | Tại sao cần |
|---|---|
| `proposalId`, `skillId`, `baseRevision` | Phân biệt proposal với skill đang active và ngăn lost update |
| `actor`, `originRunId`, `evidenceRefs` | Biết ai/cơ chế nào tạo thay đổi và dựa vào đâu |
| `targetScope` | Skill của user, project hay tổ chức; không suy từ tên folder |
| `mutationKind` | Create, patch, archive… có quyền khác nhau |
| `requiredCapabilities` | Mô tả dependency; **không** tự cấp quyền tool/secret |
| `validationResult`, `evaluationResult` | Phân biệt hợp lệ về định dạng với cải thiện hành vi |
| `approvalRef` | Tham chiếu quyết định host, không phải chuỗi JSON do model tự ký |
| `publishedRevision`, `rollbackRef` | Biết phiên bản nào được kích hoạt và hoàn tác về đâu |

### 9.6. Read-before-write phải gắn revision

Hermes có read-mark theo target path trong review context. Với store phân tán hoặc nhiều writer, chỉ “đã đọc path” chưa đủ để chứng minh nội dung chưa đổi. **ĐỀ XUẤT:** read trả revision/hash; proposal giữ revision đó; publish/patch dùng CAS. Nếu skill đã thay đổi sau review hoặc sau approval, phải đánh giá lại, không apply patch dựa trên bản cũ. [H06] [S09]

### 9.7. Không dùng skill để mở rộng authority

Skill mới có thể yêu cầu “hãy gọi tool X”, nhưng chỉ host quyết định tool X có ở catalog và được phép chạy hay không. Tương tự, metadata “requires API key” không được tự làm secret xuất hiện trong guest environment.

Đề xuất tuyệt đối không cho learner tự sửa: developer instructions của agent, sandbox defaults, allowlist, credential store hoặc approval policy. Learner viết nội dung hướng dẫn vào scope được cấp, không sửa control plane.

### 9.8. Eval gate thực tế, không hứa “càng dùng càng thông minh”

Một evaluation có ích phải kiểm:

- Task cần skill có hoàn thành đúng hơn không?
- Task không liên quan có bị skill kích hoạt nhầm không?
- Có tăng tool call, token, lỗi hoặc yêu cầu quyền không cần thiết không?
- Có giữ nguyên ràng buộc read-only và scope không?
- Skill có làm sai task mà phiên bản cũ từng xử lý được không?

So sánh base revision và candidate trên cùng tập task, cùng config/model, với sự biến thiên được ghi lại. Những task dùng để tạo skill không được là toàn bộ tập đánh giá. Đầu ra nên là `accept / reject / needs-review`, không buộc một điểm tổng hợp che mất regression về an toàn.

### 9.9. Curator nên đến sau proposal store

Chưa cần bắt đầu bằng một agent chạy hàng loạt lượt LLM để hợp nhất skill. Có thể làm trước: usage metadata, pin theo policy rõ ràng, phát hiện trùng, liệt kê stale candidates và archive thủ công có rollback. Sau khi thư viện đủ lớn và có cost/quality evidence mới bật consolidation tự động.

---

<a id="10-runner"></a>
## 10. Chuyển giao quyền sở hữu tác vụ và kết quả nền

### 10.1. Những trạng thái không được gộp làm một

```text
Model đã trả lời
≠ tool đã hoàn tất
≠ kết quả đã được lưu bền vững
≠ owner còn quyền ghi vào conversation
≠ kết quả đã được giao tới người nhận
```

SDK đã có operation journal để phân biệt hoàn thành và outcome unknown; OpenClaw có lifecycle writer checks và các trạng thái terminal; Hermes có logic chọn nơi nhận kết quả background. Các module này giải quyết những phần khác nhau của chuỗi trên. [S02] [O11] [H09]

### 10.2. Hermes: kiểm tra khả năng nhận kết quả trước khi detached

`_capture_origin()` lấy identity/capability của session gốc trước khi tạo child, vì việc tạo child có thể thay đổi context đang bound. `_resolve_async_wake_sid()` phân biệt phiên one-shot, phiên hỗ trợ async delivery và phiên dùng server-history nhưng không có quyền wake. Một số phiên hữu hạn rơi về thực thi đồng bộ để không trả handle mà không ai nhận kết quả. [H09]

Khi child hoàn tất, code ghi kết quả từng child vào unit trước khi chờ join/finalize toàn nhóm; đường ghi đó được mô tả best-effort. **Không nên biến mô tả này thành cam kết tất cả task con sẽ được phục hồi đầy đủ sau crash.** Completed-result salvage khác với khả năng chạy tiếp stack/promise của child. [H09]

Một nhánh helper đã đọc trả giá trị hỗ trợ async khi import/check ném exception. Do đó cũng không nên mô tả mọi error path upstream là fail-closed tuyệt đối. Với extension SDK, fallback khi không xác định được consumer nên được thiết kế tường minh: chạy inline hoặc từ chối detach, không tự giả định có consumer. [H09]

### 10.3. OpenClaw: lifecycle event cũng phải có owner

`persistGatewaySessionLifecycleEvent()` kiểm expected writer, session ID, lifecycle revision và trạng thái run trong callback patch entry. Nó bỏ qua event từ session cũ hoặc owner không còn phù hợp, và ngăn delayed start mở lại một run đã terminal. Nhánh cron continuation còn kiểm owner hiện tại của continuation. [O11]

Lesson nên chuyển giao: **completion callback có thể đến muộn sau reset/restart/replacement, nên “có callback” không phải quyền commit.** Không chỉ kiểm AbortSignal trước khi dispatch; phải chặn late result ở ranh giới publication/commit.

### 10.4. Runner tùy chọn: dùng những gì SDK đã có

**ĐỀ XUẤT:** runner ngoài core sở hữu job admission, claim/lease, snapshot store, result inbox và kênh giao kết quả. Bên trong task vẫn dùng AgentSession/AgentTeam hiện tại và `ToolExecutionStore` cho tác dụng phụ. [S02] [S06] [S07] [S08]

Một schema khái niệm:

```text
Task
  taskId
  ownerScope
  definitionRef / configRevision
  status
  leaseOwner / leaseGeneration / leaseExpiry
  checkpointRef
  resultRef
  deliveryState

ToolOperation
  operationId
  validated request identity
  claimed / completed / unknown

ResultReceipt
  result identity
  intended consumer
  source task/run/generation
  pending / acknowledged / rejected
```

Đây là mô hình đề xuất, không phải yêu cầu mọi SDK consumer phải cài database hoặc queue.

### 10.5. Failure windows và cách xử lý

| Failure window | Hành vi đề xuất |
|---|---|
| Chết trước khi task được claim | Worker khác có thể claim theo policy |
| Chết sau task claim nhưng trước side effect | Reconcile task và operation journal; không đoán chỉ dựa task status |
| Side effect thành công, result commit chưa xác nhận | `unknown`; không tự chạy lại thao tác không idempotent |
| Result đã commit, delivery lỗi | Retry delivery bằng cùng receipt, không chạy lại agent/tool |
| Lease hết hạn nhưng worker cũ vẫn sống | Chặn commit/launch mới bằng fencing; không khẳng định mọi side effect cũ đã dừng |
| User reset hoặc thu hồi quyền trong lúc worker chạy | Kết quả không tự append/wake dưới owner mới; lưu hoặc từ chối theo policy |
| Parent không có persistent consumer | Inline hoặc refuse-detach; không trả lời rằng sẽ tự báo sau |

Lease/CAS không tự tạo exactly-once cho hệ thống bên ngoài. Với side effect ở API khác, cần idempotency key, phép đọc reconciliation hoặc quy trình người vận hành. Không có dữ liệu chứng minh thành công thì giữ `unknown`.

### 10.6. Cron và gateway đặt ở đâu

Cron chỉ nên là một nguồn tạo task hoặc đánh thức một workflow đã được host cho phép. Message từ webhook/chat cũng là một nguồn input. Không cần nhét Telegram/Slack/Teams parsing vào agent loop.

Bản rà soát này **không audit toàn bộ cron engine và channel connectors của hai upstream**, nên không đề xuất copy các engine đó. Chỉ chuyển các semantics đã kiểm tra ở background routing và lifecycle ownership. Một scheduler bên ngoài đã có sẵn trong ứng dụng có thể tạo task qua runner; không bắt buộc SDK phát triển thêm cron riêng.

---

<a id="11-khong-copy"></a>
## 11. Những gì nên giữ, không nên sao chép

### 11.1. Giữ staged tool pipeline

Không để remote backend, code program hoặc agent con đi qua một đường đặc biệt bỏ pre-policy, approval hay post-policy. Chính đường `finalizeToolCall` hiện tại tái dựng envelope khi sanitize là một invariant nên giữ. [S10]

### 11.2. Giữ sandbox policy tách khỏi executor

`confine()` tạo wrapped argv; `fence()` kiểm soát file effects trong process. Thiếu backend hoặc không đạt `requireEnforcement` phải được nhìn thấy là lỗi. Source không tuyên bố các mức `partial` và `full` tương đương nhau. [S13]

Không dùng “read-only filesystem” để suy ra mọi command là read-only nghiệp vụ. Một lệnh có thể gọi API, restart service hoặc tác động qua socket. Chính adapter/host policy phải quy định phạm vi thực thi tương ứng.

### 11.3. Không bê application globals vào Universal core

Hermes sử dụng process/thread/profile context; OpenClaw sử dụng Node runtime và một số registry process-wide. Những cơ chế này có thể hợp lý trong application của họ, nhưng không nên làm SDK consumer browser/edge phải thừa hưởng môi trường Node hoặc global state đó. [H08] [H09] [O01] [O09]

Port invariant và test trước; viết lại wiring theo ownership của SDK.

### 11.4. Không bê default auto-learning hoặc fallback rộng

Default của OpenClaw không phải chuẩn bắt buộc cho SDK. Curator của Hermes cũng có nhánh best-effort trong maintenance. Chọn lại default dựa trên quyền mà host có thể kiểm soát: tắt mutation tự động, không auto-expand tools/secrets và không silently fallback execution sang môi trường rộng quyền hơn. [O06] [H04] [H05]

### 11.5. Không thêm generic abstraction chỉ vì tên nghe hợp lý

Không thêm `ModelPurposeRouter` chỉ để compaction dùng model khác; đã có API. Không thêm `ExecutionBackendV2` cùng trách nhiệm với backend hiện tại. Không thêm một framework multi-agent khác chỉ để có steer. Không gọi một observation exporter queue là business task runner. [S02] [S05] [S06] [S15]

---

<a id="12-trien-khai"></a>
## 12. Cấu trúc triển khai tối thiểu

### 12.1. Cấu trúc đề xuất, chưa phải kế hoạch đổi topology repository

```text
Core hiện tại — tiếp tục là nguồn sự thật
  tool pipeline + scheduler + execution contracts
  session + memory bindings
  skills read contract
  team + accounting/observability

Các extension chỉ tạo khi spike chứng minh cần
  execution adapter        → triển khai ToolExecutionBackend có sẵn
  recall adapter/tools     → index + bounded excerpt + host scope
  skill proposal extension → mutation authority + store + evaluation
  tool-program extension   → guest executor + nested tool admission
  runner host              → task ownership + checkpoint + result receipt
```

Tên package, public export và folder mới phải theo quy tắc topology của repo; **các tên ở đây là responsibility, không phải yêu cầu tạo năm package ngay**.

### 12.2. Những điểm nối hiện có và phần mới nhỏ nhất

| Công việc | Điểm nối hiện có | Phần mới nhỏ nhất cần thử | Không nên thêm |
|---|---|---|---|
| Remote/container exec | `createToolExecutionInterceptor`, `ToolExecutionBackend` [S02] | Concrete adapter + environment lifecycle conformance | Backend contract thứ hai |
| Durable operation | `ToolExecutionStore` [S02] | Store adapter với atomic claim + reconciliation | Boolean `done` thay unknown outcome |
| Approval persistence | `withApprovalPersistence` [S04] | Host persistence adapter và UI recovery behavior | Dùng lại request capability cũ |
| Cheap compaction | Summarization override [S05] | Cấu hình + eval task continuity | Router mới bắt buộc |
| Recall | Session snapshot/memory binding [S07] [S08] | Scoped index và read-only tools | Đổi toàn bộ task memory sang vector DB |
| Skill proposal | `SkillProviderPlugin` [S09] | Writer/proposal authority riêng, revision bridge | Read-provider có write authority ngầm |
| PTC | Pipeline + scheduler [S10] [S11] | Nested admission port/projection policy qua spike | Raw `tool.execute` hoặc host eval |
| Background task | Team + snapshot + tool journal [S06] [S08] [S02] | Owner/lease/result-inbox ngoài core | Copy toàn application gateway |

### 12.3. Bốn quyết định kiến trúc cần ghi lại trước implementation

**ADR-A: trách nhiệm thực thi.** Core quản lý call contract và policy pipeline; adapter sở hữu tài nguyên thực thi cụ thể. Nêu rõ ai giữ signal, ai cleanup và ai trả outcome unknown.

**ADR-B: nguồn dữ liệu được đưa vào LLM.** Audit/history của thao tác và model-visible projection không bắt buộc giống nhau. PTC có thể giữ dữ liệu trung gian ngoài context nhưng không được làm mất correlation/audit.

**ADR-C: authority và nguồn gốc.** Identity/scope/permissions do host cấp, không lấy từ model JSON. Recall và skill proposal không tự nâng nguồn thấp thành developer instruction hoặc execution grant.

**ADR-D: lifetime và recovery.** Phân biệt live promise, persisted snapshot, resumable task, unknown side effect và pending result delivery. Mỗi trạng thái có owner và quy tắc khôi phục riêng.

### 12.4. Không phá mặc định embedded

Một consumer chỉ muốn tạo agent rồi chạy trong browser/Node không phải cấu hình task database, Redis, gateway hay cron. Persistence và runner cần là opt-in. Những capability không hỗ trợ trong runtime phải bị từ chối rõ ràng, không kéo dependency runtime khác một cách âm thầm.

---

<a id="13-spike"></a>
## 13. Kế hoạch spike và đo hiệu quả

Các spike dưới đây **chưa được thực hiện**. Chúng là spec để developer/Codex/Claude Code có thể triển khai và trả bằng chứng, không phải kết quả thử nghiệm giả định.

### Spike A — execution adapter trên seam hiện có

**Câu hỏi:** một implementation duy nhất của tool có chạy đúng qua local và một backend tách biệt mà vẫn giữ policy/recovery semantics không?

**Thiết lập:** một tool read-only, một tool tạo record có operation ID, một tool chạy lệnh có timeout. Dùng backend fake cho conformance logic và backend thực để kiểm process isolation/cleanup. Không dùng credential production.

**Bằng chứng bắt buộc:** trace từng boundary; record claim/complete; lỗi khi backend không đạt requirement; kết quả cancel/cleanup; thử mất kết nối sau side effect. Lưu raw test output và platform metadata.

**Go/no-go:** không side-effect replay không rõ kết quả; không silent fallback; actor/model args không đổi trusted identity; post-policy vẫn áp dụng.

### Spike B — read-only PTC

**Câu hỏi:** giảm dữ liệu trung gian qua LLM có thực sự giúp workload mục tiêu mà không làm mất chất lượng và kiểm soát không?

**Workload đề xuất:** đọc một tập record có schema ổn định, lấy chi tiết một phần, lọc điều kiện rồi tạo báo cáo có source IDs. Thử một workload keyword lookup và một workload nối dữ liệu. Dữ liệu synthetic/local để không tốn provider tool ngoài dự kiến.

**Đối chứng:** agent dùng tools thông thường và agent có thêm `execute_program`, cùng model/config/task/dataset. Không dùng dữ liệu benchmark để viết riêng skill cho một nhánh mà không công bố.

**Đo:** success theo oracle, số tool call thật, số model round, tổng input/output/cached tokens được provider báo, tool-result bytes, peak guest/host memory nếu đo được, độ trễ, failure/retry và cancellation. Nếu usage không được báo, đánh dấu thiếu; không thay bằng 0.

**Go/no-go:** không phát sinh quyền mới; toàn bộ child calls được audit; không vượt dispatch budget; sanitized result không lọt vào guest; tổng chi phí cải thiện trong workload đã định nghĩa. Không suy rộng kết quả một task cho mọi agent.

### Spike C — recall có xóa/thu hồi và scope

**Câu hỏi:** agent tìm lại đúng bằng chứng mà không rò sang người dùng/project khác hoặc làm sống lại nội dung đã thu hồi không?

**Dataset:** hai scope có cùng từ khóa nhưng dữ liệu khác, conversation đã compact, message đã undo, record đã delete, index cố tình trễ một revision và hit cũ sau khi thay quyền.

**Oracle:** định nghĩa trước danh sách message được phép trả theo từng caller. Đầu ra phải có source reference đủ để kiểm lại và metadata partial/truncated khi cần.

**Go/no-go:** không có cross-scope hit/excerpt; missing profile/source không fallback sang nguồn khác; dữ liệu xóa không đọc lại bằng handle cũ; compaction archive vẫn được xử lý theo policy riêng.

### Spike D — skill proposal, chưa auto-publish

**Câu hỏi:** trải nghiệm lặp lại có thể sinh một candidate skill tái sử dụng được mà không mutate skill active không?

**Thiết lập:** một workflow đã có runbook, một workflow gần giống nhưng cần xử lý khác, và task không liên quan. Learner chỉ có quyền đọc evidence và ghi proposal. Không có terminal/credential mutation.

**Oracle:** schema/size hợp lệ; evidenceRefs thật; baseRevision đúng; không có grant tự cấp; task không liên quan không bị skill kéo lệch.

**Go/no-go:** proposal có thể review/publish/rollback một cách xác định; cạnh tranh revision phải bị chặn; source bị thu hồi giữa review làm publication thất bại; chất lượng phải được kiểm trên bài held-out.

### Định dạng báo cáo spike đề xuất

```json
{
  "sourceCommits": {"sdk": "...", "reference": "..."},
  "implementationCommit": "...",
  "environment": {"runtime": "...", "os": "...", "backend": "..."},
  "cases": [
    {
      "id": "PTC-01",
      "status": "passed | failed | skipped",
      "evidenceFiles": ["..."],
      "observed": {},
      "limitations": []
    }
  ],
  "quality": {},
  "usage": {"coverage": "complete | partial | missing"},
  "decision": "go | no-go | needs-review"
}
```

Đây là schema báo cáo minh họa, không phải kết quả đã thu thập.

---

<a id="14-tests"></a>
## 14. Ma trận kiểm thử chấp nhận

### 14.1. Test upstream đã đọc và bài học có thể giữ

| Nguồn test | Đã thấy assertion nào | Giá trị cho SDK |
|---|---|---|
| SDK `tool-execution.spec.ts` [S03] | Không gọi handler lần hai khi có durable result | Giữ recovery semantics khi thêm adapter |
| Cùng file [S03] | Commit result lỗi sau side effect dẫn tới unknown | Không dùng retry mù để “tăng độ ổn định” |
| Cùng file [S03] | Operation ID conflict và concurrent claimant | Đặt yêu cầu atomicity lên store adapter |
| Cùng file [S03] | Remote backend nhận host identity, kết quả vẫn sanitize | Không để transport mở đường vượt policy |
| SDK approval-rule sample [S14] | `git diff` không bao `git push`; path và shell syntax được phân biệt | Bóc tách policy semantics sẵn có trước khi import implementation khác |
| SDK exporter queue [S15] | Partial ack, batch identity, required/best-effort, seal chặn late ack | Giữ phân biệt execution outcome và observation delivery |
| Hermes profile recall [H10] | Named DB đúng; missing profile không fallback default | Thêm routing/failure tests cho recall adapter |
| OpenClaw QuickJS lifecycle [O12] | Snapshot/resume fixture, lỗi nguồn và trạng thái tiêu thụ | Kiểm lifecycle guest; không đánh đồng với durable restart |

**Tình trạng chung:** tất cả ở bảng là `TEST-READ`; chưa thực thi lại.

### 14.2. Test mới đề xuất — execution và operation recovery

| ID | Tình huống | Kỳ vọng bắt buộc |
|---|---|---|
| EX-01 | Backend yêu cầu isolation nhưng không có provider phù hợp | Lỗi rõ; không chạy host thay thế |
| EX-02 | Model truyền `tenant/admin` trong args | Trusted identity của request không đổi |
| EX-03 | Approve xong nhưng runtime handle bị retired trước launch | Không tạo process mới |
| EX-04 | Backend trả runtime ID không đúng reservation | Từ chối publication/use handle |
| EX-05 | Lệnh timeout, child cố tình bỏ qua cooperative abort | Hành vi escalation/unknown đúng contract; không báo dừng thành công khi chưa biết |
| EX-06 | Remote mất kết nối sau mutation | Reconcile/unknown; không tự retry mutation |
| EX-07 | Side effect xong nhưng durable commit lỗi | Giữ unknown; chạy lại không gọi handler lần hai |
| EX-08 | Same operation ID, args hoặc principal khác | Conflict; không reuse result của operation khác |
| EX-09 | Close trong lúc acquire/spawn đang chạy | Không orphan tài nguyên không được ghi nhận; cleanup bounded |
| EX-10 | Output/artifact lớn hoặc nguồn không kết thúc | Có giới hạn và reference/truncation; không đọc vô hạn |

### 14.3. Test mới đề xuất — programmatic tools

| ID | Tình huống | Kỳ vọng bắt buộc |
|---|---|---|
| PTC-01 | Guest gọi tool ngoài catalog được cấp | Từ chối trước body |
| PTC-02 | Guest gọi nhiều tool hơn remaining parent budget | Dừng đúng giới hạn, accounting không chỉ tính outer call |
| PTC-03 | Guest nhận kết quả mà post-policy đã redact | Không còn raw value/meta/additional context bị cấm |
| PTC-04 | Nhiều child calls song song, một sibling admission fail | Cancel/drain theo contract; không orphan sibling |
| PTC-05 | Outer program exclusive, child cũng cần exclusive | Không deadlock; policy serialization được giữ |
| PTC-06 | User cancel khi guest đang chờ approval | Guest, waiter và child call cùng kết thúc phù hợp |
| PTC-07 | Missing isolated executor | Không fallback Node VM/host execution |
| PTC-08 | Catch-all trong guest bắt lỗi operation unknown rồi retry | Unknown không bị che thành retry an toàn |
| PTC-09 | Lưu dữ liệu nguồn ngoài vào result store rồi load lại | Provenance/taint không mất |
| PTC-10 | Tool output chưa khai báo schema | Không cắt JSON rồi để chương trình dùng như object nguyên vẹn |
| PTC-11 | Guest loop CPU hoặc tạo output liên tục | Timeout/output/memory policy hoạt động, event loop host không bị chiếm vô hạn |
| PTC-12 | Continuation cũ sau reset/policy change | Bị từ chối hoặc re-admit đúng policy; không reuse authority cũ |

### 14.4. Test mới đề xuất — recall

| ID | Tình huống | Kỳ vọng bắt buộc |
|---|---|---|
| RC-01 | Hai tenant/project cùng keyword | Chỉ trả nguồn caller được phép |
| RC-02 | Search được phép nhưng read sau đó quyền đã bị thu hồi | Read từ chối dù handle từng hợp lệ |
| RC-03 | Message compacted và message undo đều inactive | Xử lý khác nhau, không hồi sinh undo |
| RC-04 | Xóa source nhưng vector/cache chưa dọn xong | Không trả text cũ; state check/tombstone vẫn chặn |
| RC-05 | Thiếu profile/database/corpus | Không fallback sang nguồn khác rộng hơn |
| RC-06 | Model gửi corpus ngoài enum | Runtime từ chối, không tin provider schema |
| RC-07 | Một message chứa dữ liệu cực lớn | Bound từng message và tổng excerpt |
| RC-08 | Cron có rất nhiều kết quả lặp | Ranking/source policy được kiểm; không vô tình che hội thoại người dùng |

### 14.5. Test mới đề xuất — skills và tác vụ nền

| ID | Tình huống | Kỳ vọng bắt buộc |
|---|---|---|
| SK-01 | Learner chỉ có read-provider | Không mutate skill active |
| SK-02 | Skill chưa đọc hoặc revision thay đổi sau đọc | Patch/publish bị chặn hoặc cần review lại |
| SK-03 | Owner/provenance unavailable | Không coi là agent-owned |
| SK-04 | External/bundled/pinned skill bị auto-review nhắm tới | Đúng policy riêng theo actor/action; không mở rộng ngầm |
| SK-05 | Một source chứa instruction tự cấp quyền | Không thành control-plane instruction/secret grant |
| SK-06 | Source session bị reset/đổi quyền trong lúc LLM review | Không publish dưới authority cũ |
| SK-07 | Curator không đọc được dependency references | Bỏ qua destructive/archive decision thay vì coi không ai dùng |
| SK-08 | Skill candidate tốt trên training task nhưng hỏng held-out | Reject/needs-review; không auto-publish |
| BG-01 | Parent one-shot, không result consumer | Inline/refuse-detach |
| BG-02 | Có result store nhưng không wake authority | Lưu receipt, không tự chạy model tiếp |
| BG-03 | Worker cũ gửi completion sau generation mới | Không ghi đè state/kết quả của owner mới |
| BG-04 | Result đã commit, gửi message lỗi | Retry delivery, không rerun task |
| BG-05 | Một child xong, sibling chưa xong thì parent crash | Giữ receipt đã commit; child chưa rõ không bị gắn completed |
| BG-06 | Lease hết hạn nhưng remote side effect chưa xác nhận dừng | Fencing publication; không hứa exactly-once hoặc dừng chắc chắn |

Toàn bộ test ở 14.2–14.5 là **đề xuất mới/chung cho adapter**, không phải tuyên bố upstream đang fail. Trước khi thêm, đối chiếu test hiện hữu để tránh nhân đôi.

---

<a id="15-roadmap"></a>
## 15. Thứ tự thực hiện và điều kiện dừng

### P0 — sửa inventory và khóa invariants

Không phát triển feature mới ở bước này. Cập nhật tài liệu internal để ghi nhận execution/store/approval/compaction/team đã có. Chạy lại test hiện hữu liên quan trong CI của repo. Tạo mapping public contract → adapter/sample → test để các đề xuất sau không lặp lại phần đã làm.

**Đầu ra:** một ADR về boundaries và một bảng conformance cho các adapter. Không phải năm package mới.

### P1 — chọn extension đầu tiên theo workload

**Khi nhu cầu là chạy command trên nhiều môi trường:** làm execution adapter trước.

**Khi nhu cầu là tìm lại quyết định/bằng chứng giữa nhiều session:** làm read-only recall trước.

**Khi bottleneck đã đo là nhiều tool result trung gian và model round:** làm PTC read-only spike trước; đừng dùng một benchmark quảng bá để kết luận đây là bottleneck của SDK.

Không cần làm ba hướng cùng lúc. Mỗi extension phải chứng minh rằng nó tái sử dụng được seam hiện hữu và giữ các invariant ở ma trận test.

### P2 — skill proposal và durable runner khi đã có nhu cầu rõ

Làm proposal store và approval/eval trước curator tự động. Làm runner ownership/result receipt khi thực sự cần công việc đi qua ranh giới request/process. Phần này có thể nằm trong host application hoặc optional package; không cần biến thành dependency mọi agent.

### P3 — các tối ưu chỉ làm sau số liệu

Hybrid recall, nhiều executor, cloud hibernation, automatic consolidation, nhiều purpose model và scheduler riêng đều cần bằng chứng sử dụng. Giữ khả năng mở rộng, nhưng không xây sẵn một hệ thống lớn để “đuổi kịp” feature list upstream.

### Điều kiện dừng một hướng chuyển giao

Dừng hoặc thu hẹp khi: không đo được lợi ích trên task đại diện; phải phá ownership/core portability; không thể giữ unknown-outcome semantics; phải cấp quyền rộng hơn để tiện chạy; hoặc API mới chỉ trùng trách nhiệm API hiện hữu.

---

<a id="16-license"></a>
## 16. License và cách chuyển mã

Root `LICENSE` của Hermes ở commit đọc là MIT, copyright Nous Research; root OpenClaw cũng là MIT và dẫn tới `THIRD_PARTY_NOTICES.md`. Đây là dữ kiện từ file license, **không phải kết luận rằng mọi dependency hay file được nhúng đều có cùng điều kiện**. [H11] [O13]

Khi chuyển một phần code thực tế, ghi lại repo/commit/file gốc, giữ notice cần thiết của phần đó và kiểm tra third-party/dependency tương ứng. Báo cáo này chưa audit toàn bộ notices hoặc license của QuickJS/WASI và các dependency khác.

Ba mức chuyển giao nên được phân biệt:

| Mức | Khi nào phù hợp | Ví dụ |
|---|---|---|
| Port test/spec | Gần như luôn nên làm trước | unknown outcome, missing profile không fallback, stale owner không commit |
| Port thuật toán nhỏ | Khi ít dependency và semantics phù hợp | xử lý bounded excerpt hoặc trạng thái skill, sau khi kiểm license file |
| Dùng nguyên module/package | Chỉ khi dependency/lifetime/API phù hợp | Không mặc định phù hợp với các module application của hai repo |

Với Hermes Python, thường nên chuyển semantics/test và hiện thực theo TypeScript SDK. Với OpenClaw TypeScript, cùng ngôn ngữ không đồng nghĩa module có thể import trực tiếp: các file đã đọc kéo runtime/plugin/session/application types đặc thù. [H03] [H08] [O01] [O02] [O09]

---

<a id="17-chua-xac-minh"></a>
## 17. Những câu hỏi vẫn cần xác minh trước khi merge

### 17.1. Chưa có bằng chứng thực nghiệm

Không có số liệu so sánh quality, token efficiency, latency, peak memory hoặc mức độ an toàn giữa ba hệ thống trong báo cáo. Test đã đọc cho biết kỳ vọng và cách tác giả tái hiện tình huống, không thay thế kết quả thực thi trên commit/platform của SDK.

### 17.2. Chưa audit toàn bộ public surface và sample của SDK

Những phát hiện mới cho thấy việc chỉ đọc README dễ bỏ sót tính năng. Vì vậy, trước khi thêm recall/PTC/runner API phải tìm lại các extension/sample/export chưa nằm trong danh mục, đặc biệt entrypoint theo package và các runtime composition surface. “Chưa xác nhận” trong tài liệu này không được tự động đổi thành “chưa có”.

### 17.3. Chưa xác nhận end-to-end mọi backend upstream

Không audit toàn bộ Docker/SSH/Modal/Daytona/QuickJS implementation, credential paths hay toàn bộ network policy. Không có cơ sở gắn nhãn “an toàn hơn” cho một repo dựa vào interface hoặc tài liệu. Các capability đã đọc là phạm vi thiết kế, còn enforcement cần platform tests.

### 17.4. Chưa có bằng chứng self-learning efficacy

Các đoạn curator/workshop đã đọc không phải một benchmark chứng minh learning loop cải thiện task success. Không khẳng định upstream không có bất kỳ eval nào ở nơi khác; chỉ nói báo cáo chưa thu thập được kết quả để dùng làm cơ sở định lượng. Phần eval gate là đề xuất cần triển khai và đo.

### 17.5. Version compatibility và packaging còn phải kiểm

Commit main, package published và docs website có thể khác nhau. Khi làm implementation phải kiểm runtime exports của đúng package build, không chỉ `.d.ts`; universal entrypoint không được kéo Node dependency; tests cần chạy với môi trường target. Không sử dụng “compile được trong repo” như bằng chứng tarball tiêu thụ được ở mọi runtime.

### 17.6. Một phạm vi chủ động không làm

Không so sánh số sao/fork, không dùng phản hồi Reddit làm bằng chứng cấu trúc code, không đánh giá model nào giỏi hơn, không audit toàn bộ UI/channel/cron. Tài liệu tập trung vào những cơ chế có thể chuyển giao sang SDK mà đã lần được tới code cụ thể.

---

<a id="18-sources"></a>
## 18. Danh mục bằng chứng đã đọc

Mã nguồn được truy xuất trực tiếp qua GitHub connector tại commit cố định. Bảng dưới ghi phạm vi thực sự xem; không đánh dấu các đoạn chưa đọc là đã audit. Link mở file của đúng commit, không trỏ vào `main` động. Các reference trong nội dung dùng cùng danh mục này.

| ID | Repo | Loại | File / đường code | Phạm vi đã xem | Vai trò bằng chứng |
|---|---|---|---|---|---|
| [S01] | sdk | CODE | `packages/core/src/index.ts` | 1–260 / toàn bộ nội dung trả về | Public exports; execution, approval, composition. |
| [S02] | sdk | CODE | `packages/core/src/agent/tool/execution.ts` | Toàn bộ | ToolExecutionBackend, ToolExecutionStore, createToolExecutionInterceptor. |
| [S03] | sdk | TEST-READ | `tests/unit/tool-execution.spec.ts` | Toàn bộ | Recovery, conflict, unknown outcome, concurrency, remote backend và hậu kiểm. |
| [S04] | sdk | CODE | `packages/core/src/agent/tool/approval.ts` | 1–310 / toàn bộ nội dung trả về | Fresh approval identity, interactive broker, withApprovalPersistence. |
| [S05] | sdk | CODE | `packages/core/src/agent/memory/compaction-config.ts` | 1–260 / toàn bộ nội dung trả về | summarizationProvider/Model/Effort và validation. |
| [S06] | sdk | CODE | `packages/core/src/agent/team/managed.ts` | 1–290; 320–660 | Managed workers, dependency/write-scope options, steer, lead lifecycle. |
| [S07] | sdk | CODE | `packages/core/src/agent/memory/persistence-types.ts` | Toàn bộ | MemoryStore load/commit/revision, scope và binding requirements. |
| [S08] | sdk | CODE | `packages/core/src/agent/define/session.ts` | 1–260 | Session construction, snapshot/resume/reset và skill state. |
| [S09] | sdk | CODE | `packages/core/src/agent/skill/provider/types.ts` | Toàn bộ | Revisioned read-only skill provider contract. |
| [S10] | sdk | CODE | `packages/core/src/agent/tool/pipeline.ts` | 1–300 | prepare → authorize → dispatch → finalize; result sanitization. |
| [S11] | sdk | CODE | `packages/core/src/agent/loop/schedule.ts` | 1–290 | runToolCalls, budget, concurrency, trace và before-dispatch checkpoint. |
| [S12] | sdk | CODE | `packages/core/src/agent/loop/run-turn.ts` | 1–260; đọc lại 1–80 | Turn ownership, event stream cancellation, accounting và scheduler binding. |
| [S13] | sdk | CODE | `packages/sandbox-node/src/index.ts` | 1–210 | confine/fence, functional probes, enforcement requirements, unsupported baseline. |
| [S14] | sdk | TEST-READ | `tests/unit/chat-agents-approval-rules.spec.ts` | 1–210 | Sample command grant widths; git diff vs git push; shell syntax và executable paths. |
| [S15] | sdk | TEST-READ | `tests/unit/composition/delivery-queue-scheduler.spec.ts` | 1–200 / toàn bộ nội dung trả về | Observation delivery batches, partial ack, required/best-effort, seal. |
| [S16] | sdk | CODE | `packages/core/src/agent/tool/index.ts` | Toàn bộ | Staged dispatch exports, execution, approval, output budget/spill APIs. |
| [H01] | hermes | CODE | `agent/conversation_loop.py` | 1–260 | Turn phases, compaction pressure/rearm và review budget guards. |
| [H02] | hermes | CODE | `tools/code_execution_tool.py` | 1–230 | PTC facade, enabled tool intersection, output limits và spill metadata. |
| [H03] | hermes | CODE | `tools/code_execution_rpc.py` | 1–290 / toàn bộ nội dung trả về | RPC auth, allowlist, budget, dispatch và local/remote transports. |
| [H04] | hermes | CODE | `agent/curator.py` | 1–260 | Curator defaults, interval gates, deterministic lifecycle transitions. |
| [H05] | hermes | CODE | `tools/skill_manager_tool.py` | 1–240 | Per-skill locks, bounds, validation và optional agent-created scan. |
| [H06] | hermes | CODE | `tools/skill_manager_guards.py` | 1–230 | Ownership, pinned/deletion semantics, background read-before-write guards. |
| [H07] | hermes | CODE | `tools/session_search_tool.py` | 1–270 | Recall modes, lineage, archived vs rewound state, content bounds. |
| [H08] | hermes | CODE | `tools/environments/base.py` | 1–280 | Process environment abstraction, shutdown fence, runtime/command error distinction. |
| [H09] | hermes | CODE | `tools/delegate_tool_dispatch.py` | 1–270 | Background result routing, origin capture, per-child recording, finite-session fallback. |
| [H10] | hermes | TEST-READ | `tests/agent/test_inline_session_search_profile.py` | Toàn bộ | Named-profile DB routing and missing-profile failure. |
| [H11] | hermes | LICENSE | `LICENSE` | Toàn bộ | Root license MIT. |
| [H12] | hermes | DOC | `website/docs/developer-guide/architecture.md` | 1–240 | Architecture map used to locate code; not substituted for implementation. |
| [O01] | openclaw | CODE | `src/agents/embedded-agent-runner/run-orchestrator.ts` | 1–280 | Embedded runtime admission, session/global lanes và captured generations. |
| [O02] | openclaw | CODE | `src/agents/code-mode.ts` | 1–250 | JS code tools, deferred tool schemas, result handles và runtime invocation. |
| [O03] | openclaw | CODE | `src/agents/code-mode-bridge.ts` | 1–260 | Replay identities, nested call context, runtime capabilities và saved-result provenance. |
| [O04] | openclaw | DOC | `docs/tools/code-mode/executors.md` | 1–230 / toàn bộ nội dung trả về | Node vs QuickJS, limits, failure policy và transient continuation semantics. |
| [O05] | openclaw | CODE | `src/skills/workshop/experience-review.ts` | 1–300 / toàn bộ nội dung trả về | Proposal/auto review, source revocation, private fork và execution allowlist. |
| [O06] | openclaw | CODE | `src/skills/workshop/config.ts` | 1–230 / toàn bộ nội dung trả về | Actual auto/auto defaults and bounded configuration. |
| [O07] | openclaw | CODE | `extensions/memory-core/src/tools.ts` | 1–260 | Closed corpus validation, runtime-owned corpus, ranked stream merging. |
| [O08] | openclaw | CODE | `src/memory/memory-artifact-provenance.ts` | 1–260 / toàn bộ nội dung trả về | Out-of-band provenance, content hash và reservation-aware rollback. |
| [O09] | openclaw | CODE | `src/agents/sandbox/backend.ts` | 1–240 | Registry generations, reserved runtime identities và provisioning guards. |
| [O10] | openclaw | CODE | `src/agents/sandbox/backend-handle.types.ts` | 1–220 / toàn bộ nội dung trả về | ExecSpec, workdir ownership, assertCurrent, termination-only cleanup. |
| [O11] | openclaw | CODE | `src/gateway/session-lifecycle-state.ts` | 1–560 | Stale-event rejection, writer/revision checks and guarded lifecycle persistence. |
| [O12] | openclaw | TEST-READ | `extensions/code-mode-quickjs/src/worker-lifecycle.test.ts` | 1–240 | Real QuickJS snapshot fixture, source locations và consumed-state retention test. |
| [O13] | openclaw | LICENSE | `LICENSE` | Toàn bộ | Root MIT plus reference to THIRD_PARTY_NOTICES.md. |
| [O14] | openclaw | DOC | `docs/concepts/agent-loop.md` | 1–240 | Runtime lifecycle map; source continuation inspected separately. |
| [O15] | openclaw | CODE | `src/config/sessions/transcript.ts` | 1–280 | Transcript facade and separation of conversation content/delivery-mirror records. |

### Ghi chú về nguồn

`CODE` và `TEST-READ` là hai mức khác nhau. Các test source được đưa vào để chỉ rõ hành vi cần giữ, không phải báo cáo CI. Tài liệu `DOC` được dùng để định hướng hoặc ghi nhận lời công bố chính thức; những phần chưa kiểm bằng implementation được gọi đúng là tài liệu, đặc biệt mức cô lập và continuation của Code Mode executor.

---

<a id="19-ket-luan"></a>
## 19. Kết luận cuối

**Phần đáng bê từ Hermes:** lifecycle của execution environment; cách giữ dữ liệu trung gian ngoài context và đọc lại output đã spill; recall có lineage/trạng thái; guard ownership/read-before-write của skill; kiểm consumer khi giao việc nền. [H02] [H03] [H04] [H06] [H07] [H08] [H09]

**Phần đáng bê từ OpenClaw:** JavaScript Code Mode và deferred tool contracts; result handles giữ provenance; runtime-generation/handle ownership; source revocation trong review fork; lifecycle commit không nhận kết quả từ owner cũ. [O02] [O03] [O05] [O08] [O09] [O10] [O11]

**Phần nên tận dụng ngay trong SDK:** execution backend/store, staged pipeline, scheduler/accounting, approval journal, compaction model override, session persistence và managed team. [S02] [S04] [S05] [S06] [S07] [S08] [S10] [S11]

Nếu chốt một chỉ dẫn cho developer thì đó là:

> **Đừng làm SDK lớn hơn bằng cách thêm lại thứ đã có. Hãy chọn một workload, chuyển một cơ chế nhỏ vào đúng điểm nối hiện hữu, port test tình huống lỗi, rồi đo chất lượng/chi phí/quyền thực thi trước khi mở rộng.**

Không có cơ sở sau lần đọc này để đề nghị thay agent core bằng Hermes, copy OpenClaw gateway vào SDK, hoặc mặc định bật một agent tự sửa skill. Có cơ sở rõ để làm các extension chọn lọc trên nền hiện tại — và để sửa lại roadmap trước đó cho nhỏ hơn, chính xác hơn.

---

## Liên kết nguồn cố định

[S01]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/index.ts
[S02]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/tool/execution.ts
[S03]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/tests/unit/tool-execution.spec.ts
[S04]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/tool/approval.ts
[S05]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/memory/compaction-config.ts
[S06]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/team/managed.ts
[S07]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/memory/persistence-types.ts
[S08]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/define/session.ts
[S09]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/skill/provider/types.ts
[S10]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/tool/pipeline.ts
[S11]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/loop/schedule.ts
[S12]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/loop/run-turn.ts
[S13]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/sandbox-node/src/index.ts
[S14]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/tests/unit/chat-agents-approval-rules.spec.ts
[S15]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/tests/unit/composition/delivery-queue-scheduler.spec.ts
[S16]: https://github.com/alvin0/ai-agent-sdk/blob/5b589b6abe6d0a61da3f55b549713456ccc8c7c4/packages/core/src/agent/tool/index.ts
[H01]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/agent/conversation_loop.py
[H02]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/tools/code_execution_tool.py
[H03]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/tools/code_execution_rpc.py
[H04]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/agent/curator.py
[H05]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/tools/skill_manager_tool.py
[H06]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/tools/skill_manager_guards.py
[H07]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/tools/session_search_tool.py
[H08]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/tools/environments/base.py
[H09]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/tools/delegate_tool_dispatch.py
[H10]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/tests/agent/test_inline_session_search_profile.py
[H11]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/LICENSE
[H12]: https://github.com/NousResearch/hermes-agent/blob/35b14ad5e24137b836d5c47c21a50c6ea7aeb785/website/docs/developer-guide/architecture.md
[O01]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/src/agents/embedded-agent-runner/run-orchestrator.ts
[O02]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/src/agents/code-mode.ts
[O03]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/src/agents/code-mode-bridge.ts
[O04]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/docs/tools/code-mode/executors.md
[O05]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/src/skills/workshop/experience-review.ts
[O06]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/src/skills/workshop/config.ts
[O07]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/extensions/memory-core/src/tools.ts
[O08]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/src/memory/memory-artifact-provenance.ts
[O09]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/src/agents/sandbox/backend.ts
[O10]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/src/agents/sandbox/backend-handle.types.ts
[O11]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/src/gateway/session-lifecycle-state.ts
[O12]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/extensions/code-mode-quickjs/src/worker-lifecycle.test.ts
[O13]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/LICENSE
[O14]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/docs/concepts/agent-loop.md
[O15]: https://github.com/openclaw/openclaw/blob/8dd24e6ec0afda70a1aaaa10b8bbc623ffa8f12a/src/config/sessions/transcript.ts
