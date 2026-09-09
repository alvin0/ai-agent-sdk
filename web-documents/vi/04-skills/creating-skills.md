# Creating Skills

## Trong bộ nhớ: `defineSkill()`

Dành cho trình duyệt, edge worker, ứng dụng nền cơ sở dữ liệu, hoặc bất kỳ host
nào không có thư mục skill:

```ts
import { defineAgent, defineSkill } from '@alvin0/ai-agent-sdk-core/agent'

const incidentTriage = defineSkill({
  id: 'incident-triage',
  name: 'Incident triage',
  description: 'Diagnose a production incident and produce a safe response plan.',
  whenToUse: 'Use for outages, elevated error rates, and degraded latency.',
  instructions: 'Establish impact, gather evidence, then propose reversible mitigations.',
  resources: {
    'references/severity.md': '# Severity\n\nSEV-1 affects most users…',
    'references/runbook.md': '# Runbook\n\n1. Check the error budget…',
  },
})

const agent = defineAgent({
  id: 'web-operator',
  instructions: 'Help the operator resolve incidents.',
  skills: [incidentTriage],
})
```

### Các trường quyết định việc lựa chọn

| Trường | Tới model khi | Mục đích |
| --- | --- | --- |
| `id` | Khám phá | Danh tính ổn định; dùng bởi `allowedSkillIds` |
| `name` | Khám phá | Nhãn cho người đọc |
| `description` | Khám phá | Skill này bao phủ gì |
| `whenToUse` | Khám phá | **Ranh giới lựa chọn.** Hãy viết dứt khoát. |
| `instructions` | Chỉ sau `load_skill` | Phần hướng dẫn thực sự |
| `resources` | Chỉ sau `read_skill_resource` | Các tệp có thể địa chỉ hoá |

`whenToUse` là trường quyết định model có chọn skill của bạn hay không. "Use for
outages, elevated error rates, and degraded latency" tốt hơn "for incidents".

> `defineSkill()` **hiện thực hoá ngay** chỉ dẫn và tài nguyên trong vùng nhớ
> JavaScript của host, dù chỉ metadata của nó vào ngữ cảnh model ban đầu. Với ứng
> dụng web còn cần hành vi mạng/I-O và vùng nhớ theo kiểu lười, hãy dùng provider.

## Kho tuỳ biến: `defineSkillProvider()`

Hiện thực cùng hợp đồng trung lập với môi trường, trên bất kỳ kho nào:

```ts
import { defineSkillProvider } from '@alvin0/ai-agent-sdk-core/agent'

const scopedSkills = defineSkillProvider({
  kind: 'skill-provider',
  id: 'scoped-skills',

  async list({ allowedSkillIds }) {
    // Gợi ý này có thể thu hẹp truy vấn cơ sở dữ liệu/API. Danh mục của SDK vẫn
    // áp lại danh sách cho phép ngay cả khi provider trả về ứng viên dư thừa.
    return await skillStore.listMetadata({ ids: allowedSkillIds })
  },

  async load(candidate) {
    return await skillStore.loadInstructions(candidate.locator)
  },

  async readResource(candidate, path) {
    return await skillStore.readResource(candidate.locator, path)
  },
})
```

| Phương thức | Trả về | Được gọi |
| --- | --- | --- |
| `list({ allowedSkillIds })` | Metadata + một **locator mờ đục** | Ở đầu mỗi lượt |
| `load(candidate)` | Phần thân được chọn + manifest tài nguyên | Sau `load_skill` |
| `readResource(candidate, path)` | Một tài nguyên | Sau `read_skill_resource` |

Locator mờ đục với SDK — nó là khoá chính, URL, hay đường dẫn của bạn. Có hai bảo
đảm đáng dựa vào:

**Danh sách cho phép được áp hai lần.** `allowedSkillIds` là một *gợi ý* giúp thu
hẹp truy vấn, nhưng danh mục của SDK vẫn lọc lại. Một provider có lỗi trả về thêm
ứng viên không thể nới rộng phần uỷ quyền của agent.

**Không có gì được nạp đầu cơ.** `load()` chỉ được gọi cho một skill mà model đã
chọn, và `readResource()` chỉ cho một đường dẫn mà nó đã hỏi.

### Nguồn theo phạm vi yêu cầu

Giữ nguồn ở phạm vi session và chỉ khai báo những id mà một agent tái dùng được
phép dùng:

```ts
const releaseReviewer = defineAgent({
  id: 'release-reviewer',
  instructions: 'Review releases and explain the evidence.',
  skillIds: ['release-review', 'incident-triage'],
})

const session = releaseReviewer.createSession({
  registry,
  skills: [scopedSkills],   // nguồn theo phạm vi yêu cầu hoặc quy trình
})
```

Cùng mẫu đó chạy được mà không cần provider từ xa nào: một web bundle có thể
truyền một mảng dùng chung các giá trị `defineSkill()` qua
`createSession({ skills })`, và mỗi định nghĩa agent chọn id của riêng nó từ mảng
đó.

## Hệ tệp: bố cục `SKILL.md`

Với một CLI trên Node, mỗi thư mục con trực tiếp của một skills root là một skill:

```text
.agents/skills/release-review/
├── SKILL.md                  # YAML front matter + chỉ dẫn
├── agents/openai.yaml        # chính sách gọi
├── references/checklist.md   # tài nguyên có thể địa chỉ hoá
└── scripts/verify.ts         # tài nguyên có thể địa chỉ hoá
```

`SKILL.md` bắt đầu bằng YAML front matter chứa ít nhất `name` (id dạng
kebab-case) và `description`:

```markdown
---
name: release-review
description: Review a release candidate and report concrete blockers.
---

Establish what changed, verify the tests that cover it, then report blockers
with file and line references.
```

Các tệp văn bản khác được phơi ra dưới dạng **tài nguyên có thể địa chỉ hoá**,
không chèn vào prompt ban đầu.

### Ẩn một skill khỏi lựa chọn của model

`agents/openai.yaml` với `allow_implicit_invocation: false` giữ skill khả dụng
trên bề mặt giao diện tường minh của host nhưng ẩn khỏi lựa chọn của model:

```yaml
allow_implicit_invocation: false
```

Dùng cho những skill mà con người chủ động kích hoạt — một runbook phá huỷ, một
checklist tuân thủ — thứ mà model không nên tự chọn.

## Đọc tiếp

- [Loading Skills](/vi/04-skills/loading-skills) — khám phá và kích hoạt
- [Skill Lifecycle](/vi/04-skills/skill-lifecycle) — revision và khôi phục
