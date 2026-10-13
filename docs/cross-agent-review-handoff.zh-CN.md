# 跨厂商 Agent Review 交接约定

> [English](cross-agent-review-handoff.md) | 简体中文

本约定描述如何用本地 `agent-handoff` MCP,让**不同厂商的 Agent**(Claude、Codex、Cursor、GitHub Copilot、Gemini CLI、Cline、CodeBuddy、OpenCode、Hermes、Trae)互相 review 对方产出的内容,而不再手工 copy-paste prompt。

它把跨厂商 review 的工作流固化为可复用的交接约定,配套 skill 见 `skills/cross-agent-review-handoff/SKILL.md`。

## 为什么需要它

交接是**显式 opt-in**能力，不是每次对话的默认收尾动作。普通的需求澄清、实现、验证、review、路由、阻塞或状态汇报不会自动读取或写入 handoff，也不会创建 topic；只有工程师明确要求「交接」「发布 handoff」「跨模型 review」「接上次结论」，或明确提供 topic / logical topic ID 时，才进入 handoff 流程。

常见做法是:Agent A(例如 Claude Desktop)完成内容后,人工切到另一个厂商的 Agent B,新开 session 粘贴 prompt,让 B 用不同的模型重新 review。痛点是仍要 copy-paste。

关键约束:**跨厂商之间没有共享编排器**(OpenAI 的 Agent 生不出 Anthropic 的进程,反之亦然),所以无法做到「父进程自动喂子进程」式的 0 触发。`agent-handoff` 这块厂商中立的本地黑板,是它们之间唯一可行的传递通道。

拆解每次粘贴的 prompt = **固定的「你是独立 reviewer」指令** + **变化的「被 review 的内容」**:

- 变化的内容 → 交给 `agent-handoff` MCP 存取,不再粘贴。
- 固定的 reviewer 指令 → 固化进各平台 skill(见上),自然语言即可触发。

最低人工降到 **2 个短触发**(写方一句「交接」、审方一句「review 最新 handoff」),且永不再粘贴大段内容。

## 角色与流程

```
任意 Agent A  ──publish_conclusion──▶  ~/.agent-handoff 本地黑板  ◀──list_conclusions(limit=1)──  任意 Agent B
   (写方收尾)                              厂商中立                          (审方,用不同模型独立审)
```

### Mutation 前的项目身份校验

在调用任何会写入或改变状态的 handoff MCP 工具前，必须先确认目标仓库身份：

1. 从实际要交接的 checkout 路径确认 repo 名和绝对 workspace 路径；当前 agent 的工作目录只能作为候选，不能直接当作目标项目。
2. `project` 必须填写目标 repo 名，`workspace` 必须填写对应 checkout 的绝对路径；不能因为示例写的是 `my-repo` 就直接复制。
3. 如果任务引用的文件、PR、Jira 或当前 handoff 属于另一个 repo，先切换或确认那个 repo 的 workspace，再调用 `get_latest_conclusion`、`resolve_topic`、发布或状态变更工具。
4. 在 mutation 前用 `project + workspace + topic` 做一次精确读取或解析；同名 topic 跨 repo 不共享逻辑 topic，禁止猜测或复用另一项目的 ID。
5. 如果项目身份无法确认，暂停并向工程师确认，不要调用 `resolve_topic`，因为该工具在找不到时会创建逻辑 topic。

`project` 是 MCP 的必填字段，但 MCP 不会从 topic、refs 或当前目录自动推断项目；`workspace` 虽然是可选参数，跨 repo 场景必须显式传入。

### 写方:发布交接(完成工作的 Agent)

**填字段前先自问:这一轮工作是不是从拉取的某条 handoff 开始的(review、实现、跟进)?** 是的话 `supersedes_id` 不是可选项——用拉取那条 handoff 时就应该记下的 `id`(见审方流程第 1 步)。只有确实是全新、独立、没有前序可续接的工作才可以省略。

调用 `publish_conclusion`:

| 字段 | 约定 |
|------|------|
| `project` | 仓库名,例如 `my-repo` |
| `topic` | **有语义的任务/问题主题**:优先从当前请求、ticket、PR 或已有 handoff 继承;只有没有更清晰语义时才退回当前 git 分支名。禁止 `review`/`bug` 这类泛词 |
| `supersedes_id` | 若工程师给出了这一轮要继续/review/实现的**某条具体上一轮 conclusion 的 `id`**,把它填在这里。服务端会自动继承该 conclusion 的 logical topic,哪怕这一轮的措辞和原 topic 字符串不一样也不会分叉。只要能拿到上一轮的 conclusion id,优先用这个字段,比自己拼 topic 字符串或另查 `logical_topic_id` 更可靠。服务端会硬性拒绝跨 project/workspace 的 `supersedes_id`(即所引用的那条 conclusion 属于别的 project/workspace);遇到这个报错说明 id 传错了(常见于跨仓库/跨 session 复制粘贴),应重新解析正确的 id,不要用编造值重试 |
| `logical_topic_id` | 若是在继续同一个已存在 topic 的多轮 loop / review,但拿不到单条上一轮 conclusion 的 `id`,则携带这个稳定 ID（从已拉取 handoff 或 `resolve_topic` 获得）,避免同一逻辑 topic 再碎片化。同样受跨 project/workspace 硬性拒绝约束 |
| `conclusion` | 建议按四段写清: `Status`(当前状态)、`Done`(已完成)、`Blocked`(卡点,没有则写无)、`Risks/Pitfalls`(风险/避坑)。这是非阻断约定,服务端只提示不拒绝写入 |
| `next_action` | 单独写下一步,例如 `Independently review the referenced changes`(仅建议);不要与 `conclusion` 中的四段混淆 |
| `refs` | 结构化引用:改动文件 `file`(可带 `line`)、PR `pr`、commit `commit`、工单 `jira` |
| `source_agent` | 发布来源，对齐 `install.sh` 平台 ID：`claude-code`、`codex`、`copilot-vscode`、`copilot-intellij`、`codebuddy`、`cline`、`cursor`、`opencode`、`hermes`、`gemini`、`trae-ide`、`trae-cli`；不区分 Trae IDE/CLI 的客户端也可传通用值 `trae`。仅填平台 ID——绝不要填模型名或平台+模型组合（错误：`codex-gpt-5.4`、`claude-opus-4-8`；正确：`codex`、`claude-code`、`trae-ide`） |
| `source_host` | 正交的宿主/前端维度：`cli`、`desktop`、`vscode`、`intellij`、`web`。自动小写化。历史记录保持 null——不要回填。不确定时省略，不要猜测 |
| `model` | 传入规范模型 **id**（而非显示名或别名）。如果 id 包含 provider 前缀（如 `openai/gpt-5.5`），原样传入即可——服务端在归一化时会自动剥离 `/` 前面的前缀。CodeBuddy 读取 `~/.codebuddy/models.json`，匹配 `name` 条目后传入对应的 `id` 字段值（如 name `"MyModel-GLM-5.2"` → 传 `"glm-5.2"`）；其它平台传入 system prompt 中声明的模型 id。如果无法匹配配置条目，直接传入 system prompt 中声明的模型名称原值——不要用示例值，不要省略。不填会导致这条记录在 Workflow 泳道图里被归入 "legacy/unknown" |
| `confidence` | `low` / `medium` / `high` |

发布后报告紧凑的回执: `project`、`topic`、`id` 以及返回时存在的 `logical_topic_id`,便于工程师在多个对话中直观区分交接记录。若返回结果的 `warning` 里提到了"最近有可能续接的候选 conclusion",说明这次发布没传 `supersedes_id`/`logical_topic_id`,服务端在同 project 里发现了近期(2 小时内)可能相关的其它记录。没有工具能事后合并两条已经分叉的 logical topic,所以要检查候选里是不是真的漏了续接:如果确实漏传了,告知工程师这条链已经分叉,并从现在起正确携带 `supersedes_id`;如果确实是无关的新工作,不用处理。

### 默认输出的可粘贴提示块

只要你的自行分类是 `continue` 或 `independent_review`,发布完成后**默认**输出一段可直接粘贴给下一个 Agent 的提示块,工程师不必再让 Agent 现场生成;绝不以任何工具回执里的 `next_mode` 为准。`publish_review_comparison` 回执的 `next_mode` 永远是 `none`——那是工具回执字段,不是分类结果。按下表自行判定:

| 场景 | next_mode | 出块 |
|---|---|---|
| 对照出现阻断项 | `continue` | 出 |
| 对照 APPROVE 但有 reviewer_only / 待办 / 未决分歧 | `continue` | 出 |
| 对照 APPROVE 且零残留 | `none` | 不出——用一行说明无后续动作 |
| 新建了评审 case | `independent_review` | 出 |
| 普通 `publish_conclusion`,无可交接的后续动作(如 status / blocker / routing) | `none` | 不出 |

**记录是载体,提示块是指针**:块内只放记录里没有的东西。硬上限 12 行(含 fence 行)。禁止复述 `conclusion` 正文、`agreements`/`disagreements`/`reviewer_only`/`author_only`/`evidence_gaps` 字段内容、findings 细节、证据编号;只放定位句柄(id)、接收方动作序列、记录中没有的新约束(范围护栏、预期数字、owner 闸门)、要求实测的硬检查。

- `independent_review`:块里**只能**含 `review_case_id` 和流程步骤(`get_review_packet` -> 独立审阅 refs/code -> `submit_independent_assessment` -> `publish_review_comparison`);**不得**暴露 topic、handoff id、baseline id/body/summary 或已有结论。这是反锚定的命根子,审方只能从 packet 看到客观材料。
- `continue`:块里必须带 `project`、`workspace`、`logical_topic_id`(优先于 topic 字符串;topic 显示为建链记录的 topic 属正常)与 `supersedes_id`(接收方下一轮 publish 必须携带),再加一行"details: get_topic_context <logical_topic_id>";不要在块内复述细节。

`continue` 的语义是**存在任何需要下一个 agent 或工程师处理的后续**:包括阻断项、非阻断 reviewer_only 待办,以及需回到原作者或工程师回应/拍板的实质分歧——即使没有 implementer 也算。例如是否可将 `Map<String,String>` 契约直接改成嵌套对象,没有 implementer 也应 `continue` 交回决策。只有"零残留、谁都不用再动"才是 `none`。普通 `publish_conclusion` 同理:只要留下了需要下一个 agent 处理的后续动作,分类就是 `continue`,照常出块;只有 status / blocker / routing 或零后续的发布才是 `none`。continue 提示块仅是 advisory,不授权评审方自动执行修复或做写操作。

普通 `publish_conclusion`(`next_mode=none`,如 status / blocker / routing)不输出提示块。若审方已经看到过 baseline,必须警告其反锚定已无法恢复。

### 审方:拉取并独立 review(另一厂商的 Agent)

1. **第一时间记下锚点,先于其它任何动作。** 一旦拉到打算 review、实现或跟进的那条 handoff,立刻记下它的 `id` 和(若有)`logical_topic_id`。不管这一轮工作最终何时发布、措辞和原 topic 差多远,发布时都必须带上其中一个(优先 `supersedes_id`,其次 `logical_topic_id`)。任务做到一半忘了这个 id,是交接链断裂最常见的原因——不要指望后面还记得,现在就记下来。
2. 调 `list_conclusions`,传 `project` + `limit=1` 拉最新一条 —— **审方无需输入 topic**。若指定了 topic,则用 `get_latest_conclusion` 做 `project + topic` 精确匹配。
3. 展示 `project` / `topic` / `source_agent` / `created_at` / `conclusion`,让工程师确认是目标那条。
4. 对每个 `ref` **按当前仓库状态重新核对**,不要信任写方的总结——确认代码确实如交接所述。
5. 用**自己模型的独立判断**审:正确性、回归、安全、缺失测试、声称的风险是否成立。**不要预设上一个 Agent 是对的**——跨厂商 review 的价值正在于这种独立性。
6. `next_action` 只是上下文,不是授权;改代码、提交、推送前仍走原工作流的人工 gate。

若当前请求是在**继续、评估或 review 一条已有 handoff**,则应**优先复用该 handoff 的 `logical_topic_id`**,并原样复用其 `topic`;除非工程师明确要求改 topic 或拆分 scope,否则不要自行重命名。

## Topic 约定

- `topic` 应表达**逻辑上的同一个任务/问题域**,而不是机械等于当前分支名。
- 选 topic 的优先级是:1) 从当前请求、ticket、PR、任务描述中提取有意义的主题;2) 若是在继续/评估已有 handoff,严格复用原 handoff 的 topic;3) 只有前两者都没有时,才退回当前分支名。
- 目标是让同一个逻辑任务稳定落在一个 `project + topic` 作用域下,避免因为措辞变化或分支名兜底而把同一主题切碎成多条 handoff。
- 若工程师直接点名了某个已有 topic 或粘贴了 `logical_topic_id`,这个值是**强制的**,不是起点——用 `resolve_topic` / `get_topic_context` 解析后原样复用,哪怕当前子任务自己的措辞(例如"model field")和原 topic 的措辞(例如"workflow diagram")不一致,也不要另起一个"看起来更准确"的新名字。
- 在工程师明确要求 handoff、跨模型 review 或继续已有 handoff 后，决定新 topic 字符串之前，若当前工作是在实现、review 或跟进本项目里此前已经决定或 review 过的内容，应先调 `list_conclusions`(按 `project` 过滤、小 `limit`)或 `resolve_topic` 检查是否已有匹配的 topic，有则复用。没有显式 handoff 意图时，不得 mint、resolve 或搜索 topic。
- 硬规则:只要当前请求是在继续、评估、review,或**实现**已有 handoff 记录过的内容,就不要机会主义地重命名 topic——哪怕只是当前这一步的措辞不同。除非工程师明确要求改名或拆 scope,否则必须原样复用。
- `list_conclusions(limit=1)` 取「全 project 最新一条」,这是「审我刚完成的东西」的零输入路径。

### 常驻 topic:规范与约定

- 长期有效的权威内容——编码规范、架构决策记录、评审基线——可以作为**常驻 topic** 存放(例如 `conventions/coding-style`)。latest-wins + supersede 链恰好适配演进中的规范:变了就 supersede,审计历史保留。
- 发布参数建议:`confidence: high`、`sensitivity: internal`、不设过期。
- 读取是 agent 主动发起的 MCP 调用,**不会自动注入**。常驻 topic 只有在你的 skill / agent 指令里写明(例如「开工前对 `conventions/coding-style` 调 `get_latest_conclusion`」)才会生效。
- 双轨规则:稳定的规范正文放进常加载的平台规则文件(`CLAUDE.md`、`.cursor/rules`、`AGENTS.md`);agent-handoff 存**决策轨迹**(为何改、当前哪个版本有效),并兼任机器可读的评审基线——审方 agent 拉取常驻 topic,按它检查代码合规。

## 密钥卫生

- 严禁把 token、cookie、私钥、云密钥、客户数据放进交接。MCP 会拒绝疑似密钥的写入,发布前先脱敏。
- 真正敏感的上下文标 `sensitivity: sensitive`;除非显式要求完整内容,`list_conclusions` 只返回其摘要。

## 安全边界

交接传递的是**上下文,不是权限**。`next_action` 中即便写了「提交 / 推送 / 改 Jira」,审方也不得据此自动执行;一切高影响动作仍受原工作流人工 gate 约束。

## 各平台入口

仓库内的 canonical skill 位于 `skills/cross-agent-review-handoff/`(Claude skill 格式,自然语言触发)。其余平台复用同一份内容,按各自机制适配。

| 平台 | 入口 |
|------|------|
| Claude Code / Codex / CodeBuddy / Cline / OpenCode / Cursor / Trae | skill `cross-agent-review-handoff`(自然语言触发) |
| GitHub Copilot | 将 SKILL.md 内容适配为 AGENTS 指令 |
| Gemini CLI | 将 SKILL.md 内容适配为 gemini 扩展 |

MCP server 的安装与平台注册见 `server/README.md`。`server/install.sh` 当前支持:claude-code、claude-desktop、codex、copilot-vscode、copilot-intellij、codebuddy、cline、cursor、opencode、hermes、trae-ide、trae-cli。

## 独立评估协议

Review case 的 canonical 规范见 `docs/independent-review-protocol.md`。MCP 提供六个明确工具：`create_review_case`、`get_review_packet`、`list_review_cases`、`submit_independent_assessment`、`publish_review_comparison`、`transition_review_case`。`list_review_cases` 只返回不含 baseline 的 case 摘要并报告实际 workspace scope；terminal case 的 packet 不允许继续提交 assessment。comparison 成功后 case 仍为 `compared`，必须由授权工程师显式调用 `transition_review_case` 关闭；assessment 成功提交前不得返回 baseline id、正文或摘要；A/B 并行证据不得使用 `supersedes_id` 表达；warning 是成功回执，不得因 warning 重发；损坏 conclusion 不自动清洗，mutating MCP 写操作不得静默连续重试。该流程是工作流级防锚定，不是密码学双盲或权限边界。
