# Context Sections

Context section là một **callback mà vòng lặp lượt chạy lại trước mỗi vòng gọi
model**. Nó sở hữu đúng một node trên bề mặt model và chỉ ghi lại node đó khi
nội dung thực sự thay đổi.

```ts
import { defineContextSection } from '@alvin0/ai-agent-sdk-core'

const clock = defineContextSection({
  id: 'wall-clock',
  resolve() {
    const text = `Current time: ${new Date().toISOString()}`
    return { revision: text, text }
  },
})
```

## Vì sao không dùng system prompt

System prompt là **tiền tố cache**. Ghi lại nó giữa session sẽ huỷ prompt cache,
còn `additionalInstructions` chỉ có thể thêm vào — không có cách nào thu hồi
đoạn văn bản đã không còn đúng.

| Cơ chế | Đổi được giữa session? | Thu hồi được? | Chi phí khi không đổi |
| --- | --- | --- | --- |
| `instructions` | Ghi lại tiền tố cache | Không | Trượt cache |
| `additionalInstructions` | Chỉ trong một lượt chạy | Không | Gửi lại mỗi lượt chạy |
| `session.inject()` | Có, thêm vào | Không | Nằm trong lịch sử tới khi bị nén |
| **Context section** | Có, thay tại chỗ | Có | **Bằng không** |

Section là công cụ đúng cho ngữ cảnh **luôn bật và luôn động**: thư mục làm
việc, nhánh hiện tại, trạng thái sự cố đang diễn ra, các tệp chỉ dẫn của dự án.
Skill là hợp đồng ngược lại — được quảng bá qua mô tả và chỉ nạp khi model chọn.

## Hợp đồng

```ts
interface ContextSection {
  readonly id: string                    // kebab-case, duy nhất trong một lượt
  resolve(input: ContextSectionResolveInput):
    | ContextSectionState | undefined | Promise<ContextSectionState | undefined>
  readonly retractionText?: string
}

interface ContextSectionState {
  readonly revision: string              // khoá thay đổi
  readonly text: string                  // văn bản chính xác model sẽ đọc
}
```

Ba giá trị trả về có thể:

| Trả về | Hiệu ứng |
| --- | --- |
| `revision` giống node đang sống | Không ghi gì. Không tốn token. |
| `revision` khác | Node của section bị **thay** tại chỗ |
| `undefined` | Thu hồi: node trở thành `retractionText` |

Một section thay đổi sẽ thay node của chính nó chứ không thêm bên cạnh, nên
model không bao giờ đọc hai phiên bản của cùng một ngữ cảnh.

Vòng lặp không xoá được node trên bề mặt, nên một lần thu hồi trở thành một
thông điệp ngắn nói rằng văn bản trước đó không còn đúng. Mặc định:
`The previously provided '<id>' context no longer applies.`

`revision` thường là digest nội dung; một bộ đếm tăng đơn cũng được nếu nơi sản
xuất đã theo dõi phiên bản.

## `resolve` nhận gì

```ts
interface ContextSectionResolveInput {
  readonly signal: AbortSignal
  readonly step: number                              // 0 trước vòng gọi đầu tiên
  readonly touches: readonly ContextToolTouch[]       // lời gọi đã chốt kể từ resolve trước
  readonly current: ContextSectionState | undefined   // đang có gì trên bề mặt
  readonly scope: ContextSectionScope                 // { agentId, conversationId }
}

interface ContextToolTouch {
  readonly toolName: string
  readonly rawArguments: string      // đối số nguyên văn từ nhà cung cấp
  readonly failed: boolean
}
```

`touches` là cách một section phản ứng với việc model vừa làm — một lần đọc bước
vào thư mục mới, một câu lệnh đổi nhánh. Một lời gọi **thất bại** thì chưa bước
vào đâu cả; hãy xử lý tương ứng.

## Khoá theo scope không phải tuỳ chọn

Một đối tượng section thường được gắn lên một definition mà nhiều session cùng
khởi tạo — mọi thành viên của một team, mọi worker nhân bản từ lead — và các
session đó chạy **đồng thời**.

```ts
// SAI: một bộ tích luỹ chung cho mọi session
const dirs = new Set<string>()

// ĐÚNG: khoá theo cuộc hội thoại đang hỏi
const dirs = new Map<string, Set<string>>()
resolve({ scope, touches }) {
  const key = scope.conversationId ?? '<unscoped>'
  // …
}
```

Section nào tích luỹ bất cứ thứ gì xuyên các bước đều phải khoá trạng thái đó
theo `scope`, không thì phát hiện của agent này rò sang ngữ cảnh của agent khác.
Cả hai trường đều vắng với một `runTurn` trần không có danh tính trace.

## Cách gắn

Ở mức definition, cho section thuộc về agent bất kể nó chạy ở đâu:

```ts
const agent = defineAgent({
  id: 'coder',
  instructions: 'You are a coding agent.',
  contextSections: [clock],
})
```

Ở mức session, khi nội dung phụ thuộc môi trường — thư mục làm việc, cây làm
việc, một tenant:

```ts
const session = runtime.agent(agent).createSession({
  contextSections: [createProjectInstructionsSection({ cwd: workspaceDir })],
})
```

Id trùng nhau bị từ chối một lần, lúc lắp, chứ không phải ở từng bước.

## Thất bại không bao giờ chí tử

Ngữ cảnh được lắp thêm mang tính **tham khảo**. Một section quăng lỗi, vượt hạn
mức, hoặc không bao giờ kết thúc sẽ bị bỏ qua ở bước đó và node cũ vẫn nguyên —
mất nó không được phép làm mất cả lượt.

`MAX_CONTEXT_SECTION_TEXT_BYTES` (256 KiB) là trần cho văn bản kết xuất của một
section. Mỗi section tự cân nội dung của mình dưới ngưỡng đó.

```ts
CONTEXT_SECTION_ID_PATTERN        // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
CONTEXT_SECTION_INVALID           // mã AgentSdkError
MAX_CONTEXT_SECTION_TEXT_BYTES    // 262_144
```

`defineContextSection` quăng `CONTEXT_SECTION_INVALID` khi id không phải
kebab-case hoặc thiếu `resolve`.

## An toàn với nén, ngay từ thiết kế

Section đọc lại bề mặt đang sống và nhận lại node nó còn sở hữu trước khi quyết
định bất cứ điều gì — ở bước đầu của một lượt mới, và ở bất kỳ bước nào sau khi
một lần nén che mất một phần bề mặt.

Không có điều đó, lượt thứ hai sẽ thêm một bản sao trùng của ngữ cảnh mà model
đã đọc được, còn node bị nén che sẽ không bao giờ được ghi lại vì revision của
nó vẫn khớp.

## Chỉ dẫn dự án

`@alvin0/ai-agent-sdk-instructions-node` là bản hiện thực Node của callback này cho các
tệp kiểu `AGENTS.md`. Core SDK không bao giờ đọc tệp.

```ts
import { createProjectInstructionsSection } from '@alvin0/ai-agent-sdk-instructions-node'

const agent = defineAgent({
  id: 'coder',
  instructions: 'You are a coding agent.',
  contextSections: [createProjectInstructionsSection({ cwd: process.cwd() })],
})
```

Nó đi ngược từ `cwd` tới mục `projectRootMarkers` gần nhất (mặc định `.git`),
đọc các ứng viên từ gốc đó **xuống tới `cwd`**, và thêm mọi cây con mà một lời
gọi tool bước vào, giữ trong tầm suốt phần còn lại của session.

| Tuỳ chọn | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `id` | `project-instructions` | Id section trên bề mặt model |
| `cwd` | `process.cwd()` | Thư mục làm việc của session |
| `globalFile` | — | Đường dẫn tuyệt đối, đọc trước mọi tệp dự án |
| `projectRootMarkers` | `['.git']` | Các mục làm dừng bước đi ngược lên |
| `fileNames` | `['AGENTS.override.md', 'AGENTS.md']` | Ứng viên trong cùng thư mục, theo thứ tự ưu tiên |
| `perDirectory` | `'first'` | Lấy `first` hay `all` ứng viên có mặt trong mỗi thư mục |
| `maxBytes` | `65536` | Trần UTF-8 cho toàn bộ section kết xuất |
| `maxFileBytes` | `maxBytes` | Trần UTF-8 cho mỗi tệp |
| `nested` | `true` | Quét các cây con mà lời gọi tool bước vào |
| `maxNestedDirs` | `256` | Số thư mục cây con giữ trong tầm cùng lúc, tối đa |
| `onNestedLimit` | — | Gọi một lần mỗi cuộc hội thoại khi chạm trần đó |
| `maxTrackedScopes` | `64` | Số cuộc hội thoại mà instance này nhớ cây con |
| `filePathFromTouch` | đọc `file_path`/`path`/`filePath` | Lời gọi đã chốt nào chạm đường dẫn nào |
| `intro` | `DEFAULT_INTRO` | Đoạn văn đặt trên các tệp |
| `retractionText` | `DEFAULT_RETRACTION` | Ghi ra khi mọi tệp ra khỏi tầm |

Kết xuất theo thứ tự rộng-tới-hẹp, mỗi tệp mở đầu bằng
`Instructions from: <đường dẫn tương đối tới gốc dự án>`. Các tệp có nội dung
trùng nhau sau khi cắt khoảng trắng gộp về lần xuất hiện đầu. Phần không vừa
`maxBytes` được **nêu tên** ở dòng kết chứ không bị cắt âm thầm.

Không có `globalFile` mặc định: một thư viện không đoán chỗ host giữ chỉ dẫn
thường trực của người dùng.

Đường dẫn tương đối theo skill không bao giờ được tính là đường dẫn workspace —
đối số mang `skillId` bị bỏ qua, nên một tài nguyên skill tên
`references/patterns.md` không thể kéo `references/AGENTS.md` vào ngữ cảnh.

## Đọc tiếp

- [Agent Context](/vi/02-agents/agent-context) — mọi thứ khác tới được model
- [Agent Instructions](/vi/02-agents/agent-instructions) — đường qua system prompt
- [Skills](/vi/04-skills/) — lựa chọn do model tự chọn
