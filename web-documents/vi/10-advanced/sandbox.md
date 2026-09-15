# Sandbox

Một lệnh bị giới hạn chạy với ít quyền hơn tiến trình đã khởi động nó.
`@alvin0/ai-agent-sdk-sandbox` định nghĩa điều đó nghĩa là gì;
`@alvin0/ai-agent-sdk-sandbox-node` cưỡng chế nó trên Linux, macOS và Windows.

```bash
pnpm add @alvin0/ai-agent-sdk-sandbox @alvin0/ai-agent-sdk-sandbox-node
```

## Một yêu cầu đi qua những đâu

Không chỗ nào vừa quyết định vừa cưỡng chế. Lệnh được **đọc**, một **outcome**
được chọn, một **policy** được giải, rồi mới có thứ **giữ** nó.

```text
   NGƯỜI DÙNG    "restart nginx giúp tôi"
     │
     ▼
 ┌───────────────────────┐
 │  classifyExec(argv)   │   đọc lệnh theo NGỮ NGHĨA
 └───────────┬───────────┘
             │  capability: service-control
             ▼
 ┌───────────────────────┐
 │  outcome              │   allow │ allow-scoped │ ask-approval │ deny
 └───────────┬───────────┘
             │  ask-approval
             ▼
 ┌───────────────────────┐
 │ approveSandboxEscal…  │   CON NGƯỜI duyệt; token không giả được
 └───────────┬───────────┘
             ▼
 ┌───────────────────────┐
 │ resolveSandboxPolicy  │   request chỉ SIẾT; chỉ approval mới NỚI
 └───────────┬───────────┘
             │  SandboxPolicy
     ┌───────┴────────┐
     ▼                ▼
 confine(argv)    fence(policy)
  tiến trình con    chính tool đó
     │                │
     ▼                ▼
 bubblewrap /      kiểm tra path
 Seatbelt          theo từng lời gọi
```

Nhánh trái và nhánh phải cưỡng chế **cùng một policy** bằng hai cơ chế khác
nhau. Không cái nào thay thế cái nào.

## Ba trục, tách bạch

Một policy trả lời ba câu hỏi riêng biệt, vì ba cơ chế khác nhau cưỡng chế chúng
và một host có thể có cái này mà không có cái kia.

| Trục | Giá trị | Do cái gì cưỡng chế |
| --- | --- | --- |
| Hiệu ứng file | `read-only`, `workspace-write`, `danger-full-access` | mount binding / profile Seatbelt |
| Tầm với mạng | `deny`, `loopback`, `allow-all` | network namespace / chặn `network*` |
| Tài nguyên | thời gian, bộ nhớ, tiến trình, CPU | lấy mẫu, **không** phải quota |

Nhét mạng vào mode file sẽ khiến mode tuyên bố thứ nó không quyết. `confine()`
báo cáo từng trục riêng cũng vì lý do đó.

## Hai tầng cưỡng chế

```text
  agent host  (tiến trình của bạn)
  │
  ├── tool tự đọc/ghi file ──────────────────► fence()     ✓ mọi nền tảng
  │
  └── tool spawn một tiến trình ─────────────► confine()   ✓ linux, macOS
                                                   │       ✗ windows (fail closed)
                                                   └── con, cháu, chắt
                                                       đều nằm trong cùng lớp bọc
```

Process sandbox không thấy tool gọi `fs.writeFile` ngay trong host agent, và
fence không đi theo được tiến trình đã spawn. Phần lớn tool của SDK thuộc loại
thứ nhất — nên fence là tầng chạy được ở mọi nơi.

```ts
import { confiningPolicy, resolveSandboxPolicy, classifyOutcome } from '@alvin0/ai-agent-sdk-sandbox'
import { localSandbox, sandboxSpawnOptions, sandboxChildStarted } from '@alvin0/ai-agent-sdk-sandbox-node'

const sandbox = localSandbox()
const policy = confiningPolicy(resolveSandboxPolicy(
  { cwd: session.cwd, sessionMode: session.mode },
  { mode: 'read-only', workspaceRoot: deploymentRoot, network: 'deny' },
))
if (policy === undefined) return spawn(argv)          // danger-full-access

const confined = await sandbox.confine(argv, policy)
const options = sandboxSpawnOptions(confined)
const result = spawnSync(confined.argv[0], confined.argv.slice(1), {
  stdio: [...options.stdio], env: { ...options.env },
})
const outcome = classifyOutcome({
  exitCode: result.status ?? 1,
  stderr: result.stderr ?? '',
  childStarted: sandboxChildStarted(confined, result.output),
}, confined)
```

`sandboxSpawnOptions` không phải trang trí. File descriptor mở **trước** khi wrap
là một capability kernel đã cấp và không mount nào thu hồi; còn environment nó
dựng là một allow-list — tiến trình spawn thường giữ đúng credential mà agent
đang chạy bằng.

## Một path lấy quyền của nó ra sao

Policy **không phải** hai danh sách. Nó là một **chồng lớp có thứ tự**, rộng
trước, và quyền tại một path là thứ mà **lớp cuối cùng** bao nó nói.

```text
 policy: workspace-write /repo
         entries: /repo/vendor = deny
                  /repo/vendor/cache = write

 grantLayers()                         rộng ──► hẹp
 ┌──────────────────────────────────────────────────────────┐
 │  write   mode        /repo                               │
 │  read    protected   /repo/.git   (.ssh .aws .netrc …)   │
 │  deny    entry       /repo/vendor                        │
 │  write   entry       /repo/vendor/cache                  │
 └──────────────────────────────────────────────────────────┘

 /repo/src/a.ts         → write
 /repo/.git/config      → read     grant không bao giờ với tới metadata repo
 /repo/vendor/x         → deny
 /repo/vendor/cache/x   → write    lớp hẹp mở lại cha đã bị deny
```

Làm phẳng thành "root được cấp" + "path bị chặn" sẽ **mất dòng cuối**: một tập
root không có chỗ nào ghi được một grant nằm *bên trong* thứ đã bị deny.

## Quyền chỉ đi xuống

```text
  mặc định deployment ──┐
                        ├──► TRẦN ─────────────► mode mà lời gọi này chạy dưới
  mode của session ─────┘         ▲          ▲
                                  │          │
  request.mode ── chỉ được ───────┘          │
                  SIẾT                       │
                                             │
  approval ── được ĐÚC, không parse ── được ─┘
              (thành viên WeakSet)     NỚI
```

Mọi thứ tool gửi lên đều là JSON do model viết, nên một input nới rộng quyền là
input model tự nới được. Request chỉ được **siết** phần thực thi của chính nó,
không bao giờ nới; nới đi qua một capability chứ không phải dữ liệu.

```ts
import { approveSandboxEscalation } from '@alvin0/ai-agent-sdk-sandbox'

// Sau khi host da thuc su duyet — mot prompt, mot policy engine.
const approval = approveSandboxEscalation({
  entries: [{ path: '/etc/app/config.yaml', access: 'write' }],
})
resolveSandboxPolicy({ cwd, approval }, defaults)
```

Chỉ giá trị do chính lời gọi đó đúc mới được chấp nhận;
`JSON.parse('{"approved":true}')` bị từ chối. Approval **tiêu hao ngay lần dùng
đầu** — người duyệt "ghi file này" đã duyệt **một** lần ghi — còn
`scope: 'session'` và `expiresAt` dành cho deployment chủ ý muốn khác.

Chú ý thứ grant trên **không** làm: nó không nhắc tới mode, nên policy vẫn là
`read-only` và đúng một file trở nên ghi được. Nâng mode thay vào đó sẽ làm cả
workspace ghi được, và cái resource được nêu tên trở thành trang trí.

## Đọc kết quả

Hai kiểu hỏng trông giống hệt nhau trong shell nhưng nghĩa ngược nhau. **denied**
= confinement đã làm việc. **runner failure** = lệnh **chưa từng chạy**.

```text
  lệnh kết thúc
        │
        ├─ exit 0 ──────────────────────────────────────► success
        │
        ├─ runner báo "tôi đã chạy nó" trên fd riêng ─────┐
        │      (bubblewrap --json-status-fd)              │ không luật
        │                                                 │ runner-failure nào
        ├─ khớp luật runner-failure trong stderr ────────► runner-failure
        │      (gate exit code + dòng fatal, đã lọc nhiễu)
        │
        ├─ bị giết bởi SIGSYS ──────────────────────────► denied
        │      (seccomp kill không cần khớp chữ nào)
        │
        ├─ exit 2 / 126 / 127 ──────────────────────────► command-failure
        │
        └─ stderr khớp phương ngữ denial của CHÍNH backend đó ─► denied
                 ngược lại ─────────────────────────────────► command-failure
```

Khớp với hợp nhất chuỗi denial của mọi backend sẽ tuyên bố những denial mà một
backend cụ thể **không bao giờ** sinh ra — nên chỉ dùng phương ngữ của backend
đang bọc.

## Quyết định trước khi cưỡng chế

Seam file không phân biệt được `systemctl status nginx` với `systemctl restart
nginx`: cả hai đều là argv, không cái nào ghi file mà policy quản, và một cái
quan sát còn một cái thay đổi máy.

```ts
import { classifyExec } from '@alvin0/ai-agent-sdk-sandbox'

classifyExec(['systemctl', 'status', 'nginx'])   // observe         -> allow
classifyExec(['systemctl', 'restart', 'nginx'])  // service-control -> ask-approval
classifyExec(['aws', 'configure', 'list'])       // credential      -> deny
```

Lệnh không nhận ra thì **không bao giờ** được allow, và lệnh giấu lệnh khác —
chuỗi shell, pipeline, chain — quyết theo mắt xích rủi ro nhất. Nó **quyết
định**; `confine()` và `fence()` mới là thứ **giữ**.

## Mỗi nền tảng thật sự cưỡng chế được gì

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Giới hạn tiến trình | bubblewrap | Seatbelt | ✗ — `confine()` fail closed |
| Mạng | network namespace | `(deny network*)` | ✗ |
| Dọn tiến trình | PID namespace | group + quét con cháu | một phần |
| Fence trong tiến trình | ✓ | ✓ | ✓ |

`confine()` báo `enforcement` là `full`, `partial` hay `fence-only` chứ không
ngụ ý. Deployment không chấp nhận mức thấp hơn thì nói ra:

```ts
localSandbox({ requireEnforcement: 'full' })   // neu khong: SANDBOX_UNAVAILABLE
```

## Những gì nó không làm

Đây là số đo, không phải giả định — mỗi mục đều được tái hiện dưới backend thật.

- **Giới hạn tài nguyên là lấy mẫu, không phải cưỡng chế.** Với hạn 300 MB, đỉnh
  chạm 382 MB trước khi sampler bắt kịp. Quota thật cần cgroup v2 hoặc Job Object.
- **Hoán đổi thành phần thư mục vẫn qua mặt được kiểm tra path.** Dùng
  `openConfinedWrite` — kiểm tra và mở trong **một** bước, từ chối symlink ở
  thành phần cuối; thư mục phía trên cần `openat2`, thứ Node không expose.
- **Tiến trình double-fork giữa hai lần lấy mẫu thoát khỏi đợt quét** trên nền
  tảng không có PID namespace.
- **Đọc mặc định là deny-list.** `baseline: 'deny'` đảo thành allow-list, do
  fence cưỡng chế; `confine()` **từ chối** thay vì giả vờ, vì đảo ngược mount
  profile nghĩa là bind đúng tập đường dẫn chương trình cần để khởi động, mà tập
  đó phụ thuộc bản dựng OS.
- **Chưa có allow-list theo hostname.** Tầm với là tất cả, loopback, hoặc không.

## Đọc tiếp

- [Security](/vi/10-advanced/security) — thông tin xác thực, chính sách endpoint, mặc định riêng tư
- [Production Deployment](/vi/10-advanced/production-deployment)
