# Loading Skills

## Khám phá qua hệ tệp Node

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-skill-filesystem
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { fileSystemSkillProviderPlugin } from '@alvin0/ai-agent-sdk-skill-filesystem'

const skills = fileSystemSkillProviderPlugin({ roots: ['./skills'] })
const runtime = await createAgentRuntime({ providers: [modelProvider] })

const agent = runtime.agent({
  id: 'coding-agent',
  model,
  instructions: 'Use the available skills when relevant.',
  skills: [skills],
})
```

Tạo provider **không gây I/O hệ tệp**. Metadata được khám phá ở đầu mỗi lượt
chạy; phần thân và tài nguyên được nạp lười với lượng đọc có chặn trên. Vòng đời
là `borrowed-caller-owned` — bạn đóng runtime; bản thân provider không có tài
nguyên nào để đóng.

## Nó tìm ở đâu

Mặc định, việc khám phá tìm `.agents/skills` từ `cwd` **đi ngược lên tới gốc
Git**.

| Tuỳ chọn | Mặc định | Tác dụng |
| --- | --- | --- |
| `cwd` | — | Điểm bắt đầu tìm ngược lên |
| `roots` | — | Tìm kiếm tường minh, khép kín, có thứ tự. Root đứng trước thắng khi trùng id. |
| `includeProjectAgents` | `true` | Khám phá `.agents/skills` |
| `includeProjectDsh` | `false` | Khám phá thêm `.dsh/skills` |
| `includeUserAgents` | `false` | Bật khám phá ở mức người dùng |
| `onIo` | — | Quan sát công việc hệ tệp có chặn trên |

Đồng thời truyền `skillCwd` khi tạo session để việc khám phá phân giải theo đúng
thư mục:

```ts
const session = agent.createSession({ skillCwd: process.cwd() })
```

### Root khép kín

Với một harness đã rà soát hoặc một bài test, hãy ghim đúng các root và tắt khám
phá theo môi trường:

```ts
fileSystemSkills({
  roots: [{ path: './fixtures/skills', source: 'reviewed-harness-corpus' }],
  includeProjectAgents: false,
  includeProjectDsh: false,
  includeUserAgents: false,
})
```

Một root có thể là chuỗi đường dẫn thường, hoặc một `FileSystemSkillRoot` với
nhãn `source` xuất hiện trong bản ghi quan sát.

## Lười và háo hức

```ts
fileSystemSkills(options)            // lười — provider được khuyến nghị
discoverFileSystemSkills(options)    // háo hức — nạp phần thân của mọi SKILL.md
```

`discoverFileSystemSkills()` cố ý háo hức: nó nạp phần thân của mọi `SKILL.md`
tìm thấy (vẫn **chưa** nạp nội dung tài nguyên). Đừng dùng cho danh mục khởi động
lớn của agent — nó tồn tại cho các công cụ thực sự cần toàn bộ định nghĩa.

## Model có thể gọi những gì

Khi đã có danh mục, ba tool xuất hiện:

| Tool | Tác dụng | Chặn trên |
| --- | --- | --- |
| `load_skill` | Đọc toàn bộ `SKILL.md` của một skill | Công bố manifest đường dẫn/kích thước có chặn trên |
| `read_skill_resource` | Đọc một tài nguyên | Văn bản bị chặn cứng; tài nguyên lớn phơi ra theo khối |
| `search_skill_resources` | **Chỉ** tìm trong skill đã nạp | 32 tài nguyên / 200.000 ký tự đã duyệt |

```ts
runtime.agent({
  /* … */
  skills: [skills],
  // Chỉnh khi một skill có nhiều tài nguyên lớn:
  // maxSearchResources, maxSearchInputChars, maxCatalogChars
})
```

Cả ba đều là **rào chắn của bộ lập lịch**, nên `load_skill` rồi
`read_skill_resource` chạy theo đúng thứ tự model, không chạy song song.

## Kích hoạt do host điều khiển

Giao diện host có thể xem danh mục và tự kích hoạt một skill, không cần model
chọn:

> **Session nào.** `.skills` nằm trên `AgentSession` của tầng `defineAgent()`;
> `RuntimeAgentSession` không phơi ra nó.

```ts
const summaries = session.skills?.summaries()
const invocable = summaries?.filter(s => s.userInvocable)

const definition = await session.skills?.activate('release-review')
```

Kích hoạt trả về định nghĩa và **cho phép các tool tài nguyên của nó**, nhưng host
phải chủ động đặt phần chỉ dẫn trả về vào một message nếu muốn nó vào ngữ cảnh
model. Không có gì bị tiêm sau lưng bạn.

Đây chính là bề mặt đi kèm với `allow_implicit_invocation: false` — một skill do
con người kích hoạt, ẩn khỏi lựa chọn của model.

## Quan sát công việc hệ tệp

```ts
const io: FileSystemSkillIoEvent[] = []

const skills = fileSystemSkills({
  roots: ['./reviewed-skills'],
  onIo: event => io.push(event),   // pha: discovery | activation | resource
})
```

Mỗi sự kiện báo pha, thao tác, đường dẫn, và số byte đã đọc (hoặc số mục đã
duyệt) — **không** đọc lại nội dung tệp. Lỗi của bộ quan sát được kiềm chế và
không bao giờ làm đổi hành vi nạp skill.

Thao tác skill cũng nằm trên bus quan sát dưới tên `sdk.skill.operation`, với số
lần khám phá/kích hoạt/đọc tài nguyên và **không bao giờ** kèm đường dẫn hay nội
dung.

## Chi phí ngữ cảnh, chính xác

```text
luôn luôn:              id + tên + mô tả + ranh giới lựa chọn
                        (mọi skill, giới hạn bởi maxCatalogChars = 8.000)

sau load_skill:         chỉ dẫn của skill đó + manifest đường dẫn/kích thước
sau read_resource:      văn bản của đúng tài nguyên đó (hoặc một khối của nó)
không bao giờ:          phần thân skill không liên quan, tài nguyên chưa đọc
```

Chỉ dẫn đã chọn và các khối tài nguyên trả về vẫn nằm trong lịch sử **cho tới khi
nén**. Sau một lần nén, model có thể gọi `load_skill` lại.

## Đọc tiếp

- [Skill Lifecycle](/vi/04-skills/skill-lifecycle)
- [Agent Context](/vi/02-agents/agent-context) — skill khớp vào cả yêu cầu thế nào
