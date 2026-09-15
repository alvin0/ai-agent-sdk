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

Các lớp trên là của **deployment**. Request và approval **không** phải thêm
entry vào cùng danh sách đó, vì ba nguồn không mang cùng thẩm quyền:

```text
  defaults.entries   ──► lớp, lớp CUỐI bao path thì thắng          (origin: entry)
        │
        ▼
  request.entries    ──► GIAO với thứ đang đứng                (origin: restriction)
        │                 mọi ranh giới do một trong hai bên nêu đều được tính
        │                 lại thành bên HẸP HƠN — nên một `deny` rộng từ request
        │                 cũng đóng luôn các grant hẹp nằm bên dưới nó
        ▼
  approval.entries   ──► áp dụng sau cùng, và được phép NỚI         (origin: approval)
                          chỉ giá trị do approveSandboxEscalation() đúc ra
```

Làm phẳng cả ba vào một danh sách last-wins chính là thứ từng cho một request mở
lại cái deployment đã đóng, chỉ bằng cách nêu một path sâu hơn.

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

## Ghép vào một agent

Không package nào phụ thuộc `-core`, và core cũng không có slot sandbox để cắm
vào. Chúng gặp nhau ở hai seam mà một session vốn đã có: **interceptor** quyết
định, **approval broker** hỏi người, còn thân tool mới cưỡng chế.

```ts
import { createApprovalBroker } from '@alvin0/ai-agent-sdk-core'
import type { ToolCallContext, ToolInterceptor } from '@alvin0/ai-agent-sdk-core/tools'
import { approveSandboxEscalation, classifyExec, type SandboxApproval } from '@alvin0/ai-agent-sdk-sandbox'

/** Argv của một tool chạy lệnh; `undefined` với tool không chạy lệnh nào. */
const argvOf = (call: ToolCallContext): readonly string[] | undefined =>
  call.toolName === 'run_command' ? commandArgv(call.args) : undefined

const asked = new Set<string>()
const granted = new Map<string, SandboxApproval>()

const sandboxInterceptor: ToolInterceptor = {
  name: 'sandbox:exec',
  before: async (call, next) => {
    const argv = argvOf(call)
    if (argv === undefined) return await next()
    const verdict = classifyExec(argv)
    if (verdict.outcome === 'deny') return { kind: 'deny', reason: verdict.reason }
    if (verdict.outcome !== 'ask-approval') return await next()
    asked.add(call.callId)
    return { kind: 'ask', reason: verdict.reason }
  },
  // `around` chỉ chạy sau khi policy và approval đã qua, nên với một call đã
  // hỏi thì việc tới được đây CHÍNH LÀ câu trả lời của người. Đúc capability ở
  // đây, không phải từ thứ model viết ra.
  around: async (call, next) => {
    if (!asked.delete(call.callId)) return await next()
    granted.set(call.callId, approveSandboxEscalation({ entries: escalationFor(call) }))
    try { return await next() } finally { granted.delete(call.callId) }
  },
}

const approvals = createApprovalBroker()
const session = agent.createSession({ tools: [runCommand], interceptors: [sandboxInterceptor], approvals })
```

`classifyExec` trả lời phần máy quyết được, `'ask'` giao phần còn lại cho broker
— đúng cách chia mà [Permissions](/vi/03-tools/permissions) mô tả. `allow-scoped`
không phải `allow`: nó nghĩa là cứ chạy, nhưng **dưới policy**.

Thân tool là nơi policy được resolve và được giữ. Nó đọc approval theo call id —
approval là một capability, và `resolveSandboxPolicy` chỉ nhận cái được đúc, không
bao giờ nhận một field trong JSON do model viết:

```ts
const runCommand = defineTool({
  name: 'run_command',
  description: 'Chạy một lệnh bên trong sandbox của workspace.',
  parameters: { /* … */ },
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    const approval = granted.get(ctx.callId)
    const policy = confiningPolicy(resolveSandboxPolicy(
      { cwd: workspaceRoot, sessionMode, ...approval === undefined ? {} : { approval } },
      { mode: 'workspace-write', workspaceRoot, network: 'deny' },
    ))
    if (policy === undefined) return await spawnUnconfined(args.argv, ctx.signal)
    const confined = await sandbox.confine(args.argv, policy)
    const options = sandboxSpawnOptions(confined)
    // … spawn với options.stdio / options.env, rồi classifyOutcome(…, confined)
  },
})
```

Tool tự đụng vào file — phần lớn tool của SDK — không spawn gì cả, nên không
process sandbox nào thấy nó. Tool đó dùng tầng còn lại, ngay trong cùng `execute`:

```ts
const fence = sandbox.fence(policy)
await writeConfinedFile(fence, target, data)   // kiểm tra và mở trong một bước
```

Ba tính chất phải sống sót qua cách ghép này, và mỗi cái hỏng là hỏng trong im
lặng: `mode` của session là **trần**, tham số tool chỉ được siết xuống; approval
do **host đúc** sau khi broker trả lời, không bao giờ parse từ tham số; và phần
phân loại **quyết định** còn `confine()` với `fence()` mới **giữ** — thiếu một
trong hai thì hoặc là hỏi mà không cưỡng chế, hoặc là cưỡng chế mà không hỏi ai.

## Mỗi nền tảng thật sự cưỡng chế được gì

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Giới hạn tiến trình | bubblewrap ≥ 0.12.0 | Seatbelt | ✗ — `confine()` fail closed |
| Mạng | network namespace | `(deny network*)` | ✗ |
| Dọn tiến trình | PID namespace | group + quét con cháu | một phần |
| Fence trong tiến trình | ✓ | ✓ | ✓ |

Khâu chọn runner **từ chối bubblewrap cũ hơn 0.12.0** — bản vá
GHSA-pxhw-h44j-8pfx, lỗ hổng cho phép thoát sandbox khi quá trình dựng tạo mục
bên dưới một symlink do kẻ tấn công điều khiển. Bản cũ bị coi là **không có
backend**, không phải backend yếu hơn.

`confine()` báo `enforcement` là `full`, `partial` hay `fence-only` chứ không
ngụ ý. Deployment không chấp nhận mức thấp hơn thì nói ra:

```ts
localSandbox({ requireEnforcement: 'full' })   // neu khong: SANDBOX_UNAVAILABLE
```

Việc kiểm tra diễn ra **theo từng lần thực thi**, so với mức mà chính lời gọi đó
đạt tới — không phải mức của rung đã chọn lúc khởi động. Một lần quét alias dừng
ở chặn trên sẽ hạ mức xuống `partial`, và deployment đòi `full` bị từ chối ngay
lần thực thi đó thay vì nhận một mức yếu hơn. `aliasScanOptions` chặn phạm vi
quét đó.

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
