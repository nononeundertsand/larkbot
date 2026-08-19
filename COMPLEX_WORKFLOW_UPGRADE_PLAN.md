# 复杂任务工作流升级规划

## 终极目标

把当前 larkbot 从“能聊天、能临时调工具的个人助理”，升级为“能接收复杂目标、拆解计划、持续执行、可恢复、可审计、能产出交付物的工作流型 Agent”。

对标方向是 WorkBudd 一类工具，但实现策略不直接追求“多个 Agent 同时乱跑”，而是先建设一个可靠的 durable workflow runtime，再逐步把文档阅读、会议安排、资料回顾、数据分析、报告生成等能力接入。

最终目标形态：

- 用户可以说：“帮我约一下下周和 A/B/C 的评审会，找个大家都有空的时间，拉会议室，发日程。”
- 用户可以说：“帮我看这几个飞书文档，做一个带引用的总结，发到群里。”
- 用户可以说：“回顾最近这个项目的会议、文档、群聊和表格，给我一份风险分析。”
- 用户可以说：“把这个表的数据做一下分析，生成可视化和结论，整理成报告。”
- 机器人能在群里多条消息汇报进度，需要确认时暂停，确认后继续，失败后可重试或明确说明失败点。

## 当前基础

已经具备的能力：

- 状态图 Agent Runtime：`reason -> act -> guard -> observe -> converge`
- 工具体系：飞书 IM、日程、任务、邮件、文档元工具、网页、Shell/Python 沙箱
- 权限策略：主人/访客、数据分级、副作用确认、安全拒绝
- 交互确认：文本确认码 + 飞书确认/取消卡片
- 本地状态层：事件幂等、审批恢复、workflow 持久区基础版
- 记忆系统：用户记忆、群共享记忆、知识图谱、冲突治理
- 评估基础：Node test + 对话级 eval fixtures

核心短板：

- 还没有稳定的任务规划器，不会把复杂目标拆成可恢复步骤。
- workflow 状态只是基础存储，还没有真正接入 Agent 执行循环。
- 还没有 artifact / citation / report 这类交付物模型。
- 长任务没有后台队列、取消、进度更新、失败重试。
- 复杂任务仍依赖单轮 LLM 自主循环，容易预算耗尽、上下文污染或中断后丢失。

## 设计原则

- Workflow first：复杂任务必须先落成 workflow 状态，再执行步骤。
- Evidence first：文档、会议、数据分析类任务必须保留来源引用，不能只给无来源总结。
- Human gates：发消息、建日程、写文档、执行高风险命令等副作用必须等待确认。
- Deterministic executor：工具执行和状态推进尽量由代码控制，LLM 负责规划、理解和写作。
- Incremental delivery：先做一个可靠 MVP，再扩到更多任务类型。
- Local-first：继续保持无 SQLite/Redis 的本地 JSON 状态体系，除非后续明确需要迁移。
- Observable：每个 workflow 都要有 trace、step log、artifact 和失败原因。

## 目标架构

### 核心模块

- `workflow-planner`
  - 把用户自然语言目标转成结构化计划。
  - 输出 `workflowType`、`steps[]`、`requiredInputs`、`riskLevel`。

- `workflow-runner`
  - 按步骤执行 workflow。
  - 管理 `pending/running/waiting_confirmation/failed/completed/canceled` 状态。
  - 负责恢复、重试、取消和进度汇报。

- `workflow-store`
  - 基于现有 `RuntimeStateStore.workflows` 扩展。
  - 保存步骤状态、artifact、citation、错误、确认 token。

- `artifact-store`
  - 保存报告草稿、文档摘录、表格分析结果、图表输出、会议候选方案等。
  - 初期仍存 JSON；文件型产物可落 `.local/artifacts/`。

- `worker adapters`
  - `doc_worker`：读飞书文档、切块、摘要、引用。
  - `calendar_worker`：查忙闲、推荐时间、创建会议。
  - `data_worker`：读表、跑 Python 分析、生成图表/结论。
  - `writer_worker`：生成报告、群消息、飞书文档草稿。
  - `reviewer_worker`：检查遗漏、引用、风险和是否需要用户补信息。

### Workflow 数据模型

建议在现有 `src/workflow.mjs` 基础上演进：

```json
{
  "workflowId": "uuid",
  "schemaVersion": 2,
  "type": "doc_report | meeting_schedule | data_analysis | material_review",
  "title": "string",
  "status": "pending | running | waiting_confirmation | failed | completed | canceled",
  "sessionKey": "string",
  "ownerId": "string",
  "userGoal": "string",
  "plan": {
    "summary": "string",
    "assumptions": [],
    "missingInputs": []
  },
  "steps": [
    {
      "id": "step_1",
      "type": "plan | tool | transform | verify | confirm | send",
      "title": "string",
      "status": "pending | running | waiting_confirmation | completed | failed | skipped",
      "input": {},
      "output": {},
      "error": null,
      "artifactIds": [],
      "citationIds": [],
      "startedAt": "",
      "endedAt": ""
    }
  ],
  "artifacts": {},
  "citations": {},
  "currentStep": 0,
  "resumeToken": "string",
  "createdAt": "",
  "updatedAt": ""
}
```

## 分阶段路线

### W0 基线对齐：复杂任务接口设计

目标：不急着实现多 Agent，先把 workflow 合同、状态和验收口径定义清楚。

任务：

- 梳理现有 `src/workflow.mjs` 和 `src/state-store.mjs` 的缺口。
- 定义 workflow v2 schema。
- 定义 artifact / citation / progress event 数据结构。
- 定义工作流状态机转换规则。
- 定义取消、重试、超时、确认恢复的语义。

建议新增或修改：

- `src/workflow.mjs`
- `src/workflow-schema.mjs`
- `test/workflow-schema.test.mjs`

验收标准：

- workflow v2 能兼容读取 v1 数据。
- 每个 workflow 都能保存 steps、artifacts、citations。
- 单测覆盖状态转换、确认暂停、恢复和失败重试。

### W1 Workflow Runner MVP

目标：让机器人能创建一个真实 workflow，并按步骤推进，不再只是单轮 Agent 自主循环。

任务：

- 新增 `workflow-runner`。
- 支持步骤类型：
  - `plan`
  - `tool`
  - `transform`
  - `verify`
  - `confirm`
  - `send`
- 接入现有确认卡片：
  - 确认后继续 workflow。
  - 取消后标记 workflow canceled。
- 群聊中输出进度消息：
  - “我先拆一下步骤”
  - “已读取 3 个材料”
  - “需要你确认是否发送”
- 加入 workflow 级别 trace。

建议新增或修改：

- `src/workflow-runner.mjs`
- `src/bot.mjs`
- `src/approval.mjs`
- `test/workflow-runner.test.mjs`

验收标准：

- 能执行一个 fake workflow：plan -> tool -> transform -> confirm -> complete。
- 进程重启后能从 `waiting_confirmation` 恢复。
- 失败步骤能记录错误并允许重试。

### W2 文档总结工作流 MVP

目标：第一个真正可用的复杂任务能力。用户给若干飞书文档链接，机器人读取、总结、带引用生成报告。

用户示例：

> 帮我看这三个文档，整理一份重点总结和风险列表，发给我确认。

任务：

- 文档链接识别：
  - docx/wiki token 提取。
  - 同一消息里多个链接识别。
- 文档读取：
  - 优先复用 lark-doc / run_lark_cli。
  - 读取失败时记录 citation error。
- 文档分块：
  - 按标题/段落切块。
  - 每块生成摘要和关键词。
- 报告合成：
  - 总结
  - 关键结论
  - 风险/待办
  - 引用来源
- 确认发送：
  - 先发草稿。
  - 用户确认后发到群或写入飞书文档。

建议新增或修改：

- `src/workflows/doc-report.mjs`
- `src/artifacts.mjs`
- `test/workflow-doc-report.test.mjs`
- `test/fixtures/workflows/doc-report.json`

验收标准：

- 使用 fake doc tools 可完整跑完。
- 报告中每个关键结论至少带一个 citation。
- 文档读取失败不会导致整个 workflow 静默失败。

### W3 会议安排工作流

目标：支持“帮我约会议”。

用户示例：

> 帮我约下周和 A/B/C 的评审会，30 分钟，尽量下午，拉会议室。

任务：

- 解析会议需求：
  - 主题
  - 参会人
  - 时间范围
  - 时长
  - 会议室偏好
- 解析参会人：
  - 姓名/邮箱 -> open_id。
  - 同名时要求澄清。
- 查忙闲：
  - calendar freebusy / agenda。
- 推荐候选：
  - 给 2-3 个时间方案。
- 确认创建：
  - 用户确认某个方案后创建日程。
  - 可选预定会议室。

建议新增或修改：

- `src/workflows/meeting-schedule.mjs`
- `test/workflow-meeting-schedule.test.mjs`

验收标准：

- 不确定参会人时不会猜。
- 创建日程前必须展示主题、时间、参会人和会议室。
- 确认后才能调用写操作。

### W4 资料回顾与项目分析工作流

目标：支持“回顾最近材料，给我一份分析”。

用户示例：

> 回顾最近两周这个项目的群聊、文档和会议纪要，分析一下当前风险。

任务：

- 来源发现：
  - 群聊上下文
  - 长期记忆
  - 飞书文档
  - 会议纪要/妙记
  - 邮件/任务
- 检索策略：
  - 关键词 + 图谱实体 + 时间范围。
  - 记录为什么选中这些材料。
- 证据汇总：
  - 摘要
  - 冲突点
  - 风险
  - 未确认假设
- 产出分析报告：
  - 带引用
  - 可追溯
  - 明确缺口

建议新增或修改：

- `src/workflows/material-review.mjs`
- `src/source-discovery.mjs`
- `test/workflow-material-review.test.mjs`

验收标准：

- 能说明使用了哪些来源。
- 能明确“没找到证据”的结论。
- 不把记忆中的冲突/废弃事实当作证据。

### W5 数据分析与可视化工作流

目标：支持“读表 -> 分析 -> 生成图表 -> 报告”。

用户示例：

> 帮我分析这个表，看看最近一周各团队问题分布，画个图并总结。

任务：

- 支持输入：
  - 飞书表格链接
  - CSV/Excel 文件
  - Base 数据
- 数据读取：
  - 表结构识别
  - 字段类型推断
  - 行数/缺失值检查
- 分析执行：
  - Python 沙箱运行分析代码。
  - 生成统计结果。
- 可视化：
  - 初期输出 markdown 表格和文本图表。
  - 后续生成图片并上传/发送。
- 报告：
  - 数据口径
  - 核心发现
  - 图表
  - 异常/限制

建议新增或修改：

- `src/workflows/data-analysis.mjs`
- `src/data-profile.mjs`
- `src/chart-artifact.mjs`
- `test/workflow-data-analysis.test.mjs`

验收标准：

- 分析前报告数据规模和字段。
- Python 代码必须在沙箱运行。
- 图表和结论必须与数据口径一致。

### W6 Multi-Agent 编排层

目标：当单一 workflow runner 稳定后，引入多角色 Agent，但保持代码级调度和状态落盘。

推荐角色：

- Planner Agent：拆计划。
- Research Agent：找材料、读文档、检索来源。
- Tool Agent：执行工具，不做最终判断。
- Writer Agent：组织报告。
- Reviewer Agent：检查遗漏、引用和风险。
- Safety Agent：检查权限、副作用和外发风险。

关键约束：

- 每个 Agent 只能读 workflow state 和分配给自己的 artifact。
- 每次 Agent 输出必须是结构化 JSON。
- Agent 不能直接执行副作用工具，只能申请 runner 执行。
- 所有中间结果落盘。

建议新增或修改：

- `src/workflow-agents.mjs`
- `src/workflow-prompts.mjs`
- `test/workflow-agents.test.mjs`

验收标准：

- 同一任务可用 fake LLM 稳定复现。
- Reviewer 可以发现缺 citation / 缺输入 / 高风险发送。
- 多 Agent 不绕过现有权限策略。

### W7 后台长任务与运维能力

目标：复杂任务不再依赖单条消息同步完成。

任务：

- 后台任务队列：
  - 每个 workflow session 串行。
  - 不同 workflow 可并发，受全局限制。
- 用户控制：
  - 查询状态
  - 取消任务
  - 重试失败步骤
  - 展示最近 workflows
- 超时策略：
  - step timeout
  - workflow timeout
  - external tool retry
- 管理命令：
  - 查看 pending approvals
  - 查看 workflow trace
  - 清理过期 artifact

建议新增或修改：

- `src/workflow-queue.mjs`
- `src/admin-tools.mjs`
- `test/workflow-queue.test.mjs`

验收标准：

- 长任务不会阻塞消息消费。
- 取消后不会继续执行副作用步骤。
- 过期 artifact 可清理。

## 推荐实施顺序

1. W0：workflow v2 schema 和 artifact/citation 设计。
2. W1：workflow-runner MVP，打通状态推进和确认恢复。
3. W2：文档总结工作流 MVP。
4. W3：会议安排工作流。
5. W5：数据分析工作流。
6. W4：资料回顾工作流。
7. W6：Multi-Agent 编排层。
8. W7：后台队列和管理能力。

优先做 W2 的原因：

- 文档总结是复杂任务的最小闭环。
- 只读为主，安全风险较低。
- 容易验证 citation、artifact、报告生成和确认发送。
- 后续资料回顾、数据分析、会议纪要总结都能复用这套能力。

## 第一阶段 MVP 任务拆解

### MVP-1 Workflow v2 schema

- 扩展 `src/workflow.mjs`。
- 添加 `artifacts/citations/userGoal/plan` 字段。
- 保持 v1 数据兼容。
- 添加 schema 单测。

### MVP-2 Runner 执行器

- 新增 `src/workflow-runner.mjs`。
- 支持 fake steps。
- 接入 `RuntimeStateStore`。
- 支持 `waiting_confirmation` 恢复。

### MVP-3 文档链接识别与读取

- 从消息中提取 doc/wiki URL。
- 通过 lark-doc / run_lark_cli 读取内容。
- 读取结果保存为 artifact。

### MVP-4 文档总结与引用

- 分块摘要。
- 每条结论绑定 citation。
- 生成报告草稿 artifact。

### MVP-5 确认与发送

- 把报告草稿发给用户确认。
- 用户确认后发送群消息或创建飞书文档。
- 取消后 workflow 标记 canceled。

## Eval 与测试策略

- 单元测试：
  - workflow schema
  - state transition
  - artifact/citation
  - runner step handling

- 集成测试：
  - fake doc read -> summarize -> confirm -> send
  - failed doc read -> partial report
  - missing input -> ask clarification

- 对话级 eval：
  - “帮我总结这些文档”
  - “帮我约会议”
  - “帮我分析这个表”
  - “取消刚才任务”
  - “继续刚才任务”

## 风险与控制

- 风险：复杂任务执行时间长，用户以为机器人卡住。
  - 控制：每个阶段主动发进度消息。

- 风险：LLM 计划不稳定。
  - 控制：计划输出 JSON schema 校验，失败则重新规划或降级澄清。

- 风险：引用缺失导致报告不可审计。
  - 控制：Reviewer 阶段强制检查 citation。

- 风险：副作用步骤被自动执行。
  - 控制：runner 层强制确认，不信任 planner。

- 风险：多 Agent 增加复杂度但不提高可靠性。
  - 控制：先做单 runner + worker adapters，多 Agent 放到 W6。

- 风险：上下文和 artifact 越积越多。
  - 控制：artifact TTL、摘要压缩、引用索引。

## 完成标准

当以下能力稳定后，可以认为复杂任务工作流第一阶段完成：

- 至少一种真实复杂任务可端到端完成。
- workflow 可重启恢复。
- 所有副作用步骤都有确认。
- 报告型任务带 citation。
- 失败可定位到具体 step。
- 用户能查询、取消、继续任务。
- 有对应单测和对话级 eval。
