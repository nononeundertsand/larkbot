# 飞书机器人智能助理（lark-cli + LLM Agent）

给飞书机器人发消息，它以「个人专属助理」身份智能回复，并能根据你的自然语言**自主调用 lark-cli 完成飞书操作**（查人、查群消息、总结群聊、查日程、建文档、发消息…）。

基于 `lark-cli` 的 **WebSocket 长连接**接收事件，**无需公网服务器、无需内网穿透、无需回调地址**。

## 架构总览

```
飞书消息 →(lark-cli event consume, WebSocket)→ bot.mjs
   ├─ 身份识别：主人 vs 访客（open_id 精确匹配，不可伪造）
   ├─ 访客身份解析：用 open_id 查姓名/部门（带缓存）
   ├─ 限流 + 安全评估（访客）
   ├─ runAgent（agent.mjs）：轻量状态图运行时（ReAct：reason→act→guard→observe→converge）
   │     ├─ Policy Engine（policy.mjs）：身份/数据级别/副作用/信息流强制门禁
   │     └─ 工具集（tools.mjs）：一等工具 + 主人专属元工具
   ├─ 有界事件队列 + 单实例重连 + lark-cli 超时
   ├─ 三层记忆（memory.mjs）：短期 + 摘要 + facts（串行维护、原子落盘）
   └─ 会话绑定的写操作二次确认
```

### 源码结构

| 文件 | 职责 |
|------|------|
| [src/bot.mjs](src/bot.mjs) | 主程序：事件循环、身份识别、限流、二次确认、记忆读写 |
| [src/agent.mjs](src/agent.mjs) | **状态图 Agent 运行时**：State + 节点 + 条件边 + ReAct 循环 + 护栏 + 优雅收敛 |
| [src/reply.mjs](src/reply.mjs) | LLM 调用、prompt 片段、安全评估、防注入、旧编排循环（`runAgentLegacy` 回滚用） |
| [src/tools.mjs](src/tools.mjs) | 工具注册表（一等工具 + 元工具）+ 权限门禁 |
| [src/policy.mjs](src/policy.mjs) | 中央能力策略：工具权限、数据敏感度、副作用、信息流控制 |
| [src/approval.mjs](src/approval.mjs) | 会话绑定的写审批状态机，防跨群/模糊确认/动作错位 |
| [src/lark.mjs](src/lark.mjs) | 统一 lark-cli 执行器：超时、输出上限、进程回收 |
| [src/models.mjs](src/models.mjs) | 多模型注册表：能力档案、任务路由、运行时切换、请求体裁剪 |
| [src/memory.mjs](src/memory.mjs) | 三层对话记忆，按用户分目录持久化 |
| [test/](test/) | Node 内置测试：权限、Agent、SSRF、超时、记忆、多模型回归 |
| `.local/skills/feishu-skill/` | 本地 lark-cli 技能包目录（被 `.gitignore` 忽略，不随开源代码上传）；也可用 `FEISHU_SKILL_ROOT` 指向其它位置 |

## 智能能力（状态图 Agent + 一等工具）

机器人不靠硬编码判断意图，而是把能力注册成**工具**，由 [agent.mjs](src/agent.mjs) 的**状态图运行时**驱动 LLM 走 ReAct 循环：**自主判断要不要调工具 → 执行 → 观察结果 → 再思考 → 自然作答**。加新功能只需在 [tools.mjs](src/tools.mjs) 加一条工具定义，主流程不用改。

**一等工具**（高频能力，LLM 一步直达、无需读文档绕路）：

| 工具 | 能力 | 身份 | 写操作 |
|------|------|------|--------|
| `calendar_agenda` / `calendar_create` | 查看 / 创建日程 | `--as user` | 建=写 |
| `task_list` / `task_create` | 查看 / 创建任务 | `--as user` | 建=写 |
| `send_message` | 代发消息给某人/当前群 | `--as bot` | 写 |
| `mail_triage` / `mail_send` | 查看 / 发送邮件 | `--as user` | 发=写 |
| `web_search` / `web_fetch` | 联网搜索 / 抓取网页正文 | 公网 | 只读 |
| `lookup_user` / `get_chat_members` / `get_user_recent_messages` / `summarize_chat` | 查人 / 群成员 / 消息 / 多页群聊总结（含有限图片识别） | 混合 | 只读 |

> 一等写工具由代码固定拼参（含正确 `--as` 身份），比让 LLM 拼命令更可靠；参会人/受派人/收件人支持传**姓名**，工具内部用公共 `resolvePersonToOpenId` 自动解析成 ID/邮箱。
>
> **网络访问**：`web_fetch`（抓正文供总结/问答）+ `web_search`（联网搜索，**provider 可切换**）。任何人可用（只读），带 **SSRF 防护**——仅 http/https、拒绝内网/本地/云元数据地址（含 DNS 解析后复查），防止借机器人探内网。
> 搜索源用 `SEARCH_PROVIDER` 切换：
> - `bing`（默认）——公网 Bing，服务端渲染、无需 key、实测最稳
> - `ddg`——公网 DuckDuckGo，备选
> - `internal`——**内网搜索 API**，endpoint/鉴权/字段映射全走 `.env`（`SEARCH_INTERNAL_*`，见 [.env.example](.env.example)），代码不写死任何内网地址；配置的内网 host 会显式放行过 SSRF。拿到内网搜索 API 文档后填配置即可启用，无需改代码。

**元工具**（长尾兜底，仅主人可用）：
- `list_lark_skills`：读路由表，判断该用哪个飞书域
- `read_lark_skill`：读某域的用法文档（SKILL.md / references）
- `run_lark_cli`：执行 AI 拼出的 lark-cli 命令；只读采用 allowlist，未知命令按写操作二次确认

于是「建文档 / 知识库 / 多维表格 / 会议纪要…」等其余域的能力在本地技能包存在时**仍全部可用**，无需逐个开发。开源仓库默认不包含技能包；请把技能包放到 `.local/skills/feishu-skill/`，或在 `.env` 设置 `FEISHU_SKILL_ROOT=/path/to/feishu-skill`。

**多模型（仅主人）**：三种粒度组合——
- **配置切换 + 能力档案**：`.env` 用 `LLM_MODELS` 定义多个模型，各自声明是否支持自定义 temperature / tools / vision / max_tokens 字段名；调用时按档案裁剪请求体，从根上规避「模型不支持某参数」的 400（GPT-5 系列必需）。
- **任务路由**：识图走多模态模型、安全/意图/记忆抽取走快模型、群聊主推理走强模型（`LLM_ROUTE_*`）。
- **运行时切换**：主人在飞书里说「换成 gpt-5」即时生效（`switch_model` / `list_models` 工具，仅主人，进程重启回落 `.env`）。

> **提示**：日历/任务/邮件工具走 `--as user`，需主人先给对应 scope 授权（如 `lark-cli auth login --scope "calendar:calendar.event:read"`）。未授权时工具会**如实返回授权错误**并转达给你，绝不编造结果。

## 安全机制

| 机制 | 说明 |
|------|------|
| **专属主人** | 主人由 `.env` 的 `OWNER_OPEN_ID` / `OWNER_NAME` 配置。身份锚在事件 `sender_id`，用户无法伪造。 |
| **访客隔离** | 访客不得获取主人隐私（私聊/消息/凭证）；查人时按 open_id 屏蔽主人本人。 |
| **提示词注入防护** | 用户输入、长期记忆、网页/邮件/群聊工具结果分别使用不可信边界；外部数据不能驱动私密读取，私密数据不能静默外联。 |
| **中央能力策略** | Policy Engine 按主人/访客、public/group/private、read/write、trusted/external 强制鉴权；访客看不到主人专属工具。 |
| **写操作二次确认** | 每轮最多登记一个副作用，确认绑定具体会话、actionId 和短确认码；需回复类似「确认 ABC123」才执行，裸「确认/ok」不会触发。 |
| **网络 SSRF 防护** | 每一跳重定向都重新校验协议、DNS/IP 和内网段；流式限制响应体，带鉴权的内网请求禁止跨主机重定向。 |
| **限流防刷** | 访客 5 次/60s/人；全局并发上限 3。主人不受限。 |

## 私聊 vs 群聊

| 场景 | 行为 |
|------|------|
| 私聊 | 收到即回 |
| 群聊 | 仅当 **@机器人** 时响应（结构化 mentions + content 文本兜底，兼容飞书不下发 mentions 的情况） |

## 对话记忆（三层 + 群共享）

| 层 | 存储 | 写入时机 |
|----|------|----------|
| 短期（最近 30 轮原文） | 默认仅内存（重启清空）；`MEMORY_PERSIST_SHORT=on` 时原子落盘、重启恢复 | 每轮实时 |
| 长期摘要 | 原子落盘（0600） | 有旧对话滑出窗口时增量压缩 |
| 结构化长期记忆（memories[]，兼容 facts） | 原子落盘（0600） | 每 5 轮抽取、相关性检索、TTL/过期清理 |

持久化按用户分目录，便于人工查看/修改：

```
data/memory/<用户名>_<openid短码>/
  ├── profile.json          身份：姓名/部门/邮箱/openId
  ├── p2p.json              私聊记忆：{summary, facts, memories[, messages]}
  └── group_<chatId>.json   该用户在该群里的场景记忆

data/memory/groups/
  └── group_<chatId>.json   群共享记忆：群主线、公开协作背景、成员角色、群风格等
```

主人与访客均享完整三层记忆并落盘，各自按 `sessionKey` 严格隔离（互不串）。
群聊场景额外维护一份群共享记忆，并在机器人被 @ 时按 `GROUP_CONTEXT_PREFETCH` 自动预取最近群聊上文，帮助 bot 自然接话，而不是只依赖模型临时决定是否读取上下文。
构造 prompt 时不会全量注入长期记忆：系统会按当前问题做相关性筛选，并用 `MEMORY_CONTEXT_BUDGET_CHARS` 控制 summary/history/memories 的总量；临时任务、决策类记忆会按 TTL 自动过期，长期未命中的非耐久记忆会被清理。
短期落盘（`MEMORY_PERSIST_SHORT=on`）会把最近原文写入场景文件的 `messages` 字段，重启后仍受 TTL 约束——超过 `MEMORY_TTL_MS` 未活动的旧短期不恢复，避免捞回很久以前的对话。

## 前置条件

1. 已安装 `lark-cli` 并授权：`lark-cli auth login`
2. 开发者后台开启事件 `im.message.receive_v1`，具备 `im:message.p2p_msg:readonly`、`im:message` 等权限
3. 查人/查通讯录等用 **user 身份**，需主人的 user token 有效
4. Node.js 18+（内置 `fetch`）

## 快速开始

```bash
cp .env.example .env   # 填 LLM 配置（见下）
./start.sh             # 前台启动
```

启动成功标志：日志出现 `[source] feishu-websocket: connected` 和 `[event] ready`。

## 启动 / 停止 / 重启

```bash
# 前台启动（Ctrl+C 停止）
./start.sh
# 后台启动
./start.sh > /tmp/larkbot.log 2>&1 &
# 停止
pkill -f "src/bot.mjs" && lark-cli event stop
# 重启
pkill -f "src/bot.mjs"; lark-cli event stop; ./start.sh > /tmp/larkbot.log 2>&1 &
# 看日志
tail -f /tmp/larkbot.log
```

## 配置项（.env）

用 `LLM_PROVIDER` 切换协议：`azure`（字节 ModelHub）或 `openai`（标准兼容）。

| 变量 | 适用 | 说明 |
|------|------|------|
| `LLM_PROVIDER` | 通用 | `azure` / `openai`（默认） |
| `LLM_API_KEY` | 通用 | 鉴权 key |
| `LLM_MODEL` | 通用 | 默认模型名，如 `gemini-3.5-flash`（需支持 function calling + 多模态） |
| `LLM_TEMPERATURE` | 通用 | 采样温度；GPT-5 等只支持默认值的模型设 `off`（不发该字段，规避 400） |
| `LLM_AZURE_ENDPOINT` | azure | ModelHub 地址 |
| `LLM_AZURE_API_VERSION` | azure | 默认 `2024-03-01-preview` |
| `LLM_BASE_URL` / `LLM_API_URL` | openai | 接口地址 |
| `LLM_MAX_RETRIES` / `LLM_FALLBACK_MODEL` | LLM | 429/5xx 最大重试（默认 2）/ 备用模型 |
| `LLM_MODELS` | 多模型 | 模型能力档案 JSON 数组（temperature/tools/vision/maxTokensField）；缺省回落全局配置 |
| `LLM_ROUTE_VISION` / `LLM_ROUTE_FAST` / `LLM_ROUTE_REASONING` | 多模型 | 任务路由：不同任务走不同模型；未配置回落默认模型 |
| `OWNER_OPEN_ID` / `OWNER_NAME` | 通用 | 主人身份；开源版本不内置真实 open_id，必须在 `.env` 配置 |
| `MEMORY_SHORT_TURNS` | 记忆 | 短期窗口轮数，默认 30 |
| `MEMORY_EXTRACT_EVERY` | 记忆 | 每几轮抽取关键记忆，默认 5 |
| `MEMORY_PERSIST_SHORT` | 记忆 | `on` 时短期原文也落盘、重启恢复（受 TTL 约束）；默认 `off`（仅内存） |
| `MEMORY_TTL_MS` | 记忆 | 短期无活动过期时长，默认 30 分钟 |
| `MEMORY_CONTEXT_BUDGET_CHARS` / `MEMORY_RELEVANT_LIMIT` | 记忆 | prompt 记忆上下文预算与每轮最多注入的相关长期记忆条数 |
| `MEMORY_TEMP_TTL_MS` / `MEMORY_TASK_TTL_MS` / `MEMORY_DECISION_TTL_MS` / `MEMORY_STALE_MS` | 记忆 | 临时、任务、决策、长期未使用记忆的遗忘策略 |
| `GROUP_CONTEXT_PREFETCH` / `GROUP_CONTEXT_LIMIT` | 群聊 | 群聊 @ 时是否预取最近上文：`smart`(默认)/`on`/`off`；默认读取 15 条 |
| `RATE_MAX_PER_SENDER` / `RATE_WINDOW_MS` / `MAX_CONCURRENT` | 限流 | 访客限流与并发 |
| `CONFIRM_TTL_MS` | 安全 | 写操作确认超时，默认 5 分钟 |
| `RESOLVE_VISITOR` | 访客 | 设 `off` 关闭访客身份解析 |
| `AGENT_MAX_ITERS` / `AGENT_MAX_TOOL_CALLS` | Agent | 最大图迭代（默认 6）/ 单次请求工具调用预算（默认 10） |
| `AGENT_ENGINE` / `ALLOW_UNSAFE_LEGACY` | Agent | 旧运行时仅调试可用，必须同时设 `legacy` / `1` |
| `LARK_TIMEOUT_MS` / `LARK_MAX_OUTPUT_BYTES` | lark-cli | 子进程超时（默认 30s）/ 输出上限（默认 2MB） |
| `EVENT_QUEUE_MAX` | 事件 | 内存事件队列上限，默认 100；并发满时排队而非直接丢消息 |
| `LOG_CONTENT` | 日志 | 默认 `off`，不记录用户正文；仅本地排障时可临时设 `on` |
| `WEB_TIMEOUT_MS` / `WEB_MAX_BYTES` / `WEB_UA` | 网络 | 抓取超时(默认 12s) / 正文字节上限(默认 ~1.5MB) / User-Agent |
| `SEARCH_PROVIDER` | 搜索 | `bing`(默认) / `ddg` / `internal` |
| `SEARCH_INTERNAL_URL` 等 `SEARCH_INTERNAL_*` | 搜索 | 内网搜索 API 的地址/鉴权/字段映射（仅 `internal` 用，见 .env.example） |
| `IGNORE_BACKLOG` / `STALE_GRACE_MS` | 事件 | 忽略启动前的历史/积压消息（默认开，`off` 关闭）/ 宽限毫秒(默认 15000) |

## 如何扩展能力

- **加一个一等工具**（高频、要一步直达）：在 [tools.mjs](src/tools.mjs) 的 `TOOLS` 数组加 `{name, description, parameters, ownerOnly?, protectsOwner?, run(args, ctx)}`。写操作在 `run` 里用 `confirmSingleWrite(ctx, argv, preview)` 接入二次确认；要按姓名找人用 `resolvePersonToOpenId(name)`。
- **无需加工具**：长尾飞书操作 AI 可通过元工具读取本地 `feishu-skill` 文档并运行 `lark-cli` 自动完成；技能包目录默认不入 git。
- **调运行时**：编排逻辑在 [agent.mjs](src/agent.mjs)（状态图）；旧运行时仅用于临时诊断，需同时设置 `AGENT_ENGINE=legacy` 和 `ALLOW_UNSAFE_LEGACY=1`。

## 开发验证

```bash
npm run check   # 所有 .mjs 语法检查
npm test        # 权限、Agent、SSRF、超时、记忆回归测试
```

## 常见问题

- **群里 @ 没反应？** 确认后台已开 `im.message.receive_v1`；看日志 `[skip] ... mentions=[...]` 排查。
- **重启后回复了一堆旧消息？** 已修复：默认忽略启动前的历史/积压消息（日志 `[skip] 忽略启动前的历史消息`）。如需处理积压，设 `IGNORE_BACKLOG=off`。
- **查人/查日程失败？** 多为 user token 失效，跑 `lark-cli auth login` 重登。
- **记忆没落盘？** 关键记忆满 `MEMORY_EXTRACT_EVERY`（默认 5）轮才抽取；频繁重启会清空内存计数。
- **换机器人？** 改 `.env` 的 `LARK_APP_ID`/`BOT_OPEN_ID`/`BOT_NAME`，或重新绑定 lark-cli。

## 安全提示

- `.env` 含 LLM key、`data/memory/` 含对话记忆，建议加 `.gitignore` 忽略，勿提交。
