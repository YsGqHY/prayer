# Prayer 项目结构与运行机制

本文说明 `prayer` 的代码结构、启动链路、消息处理机制与后台自学习闭环，面向需要接手维护或二次开发的工程师。内容基于仓库当前代码实读整理。

## 1. 项目定位与技术栈

Prayer 是一套多渠道 AI 客服中台：接入 QQ（OneBot / NapCat）与 Telegram 群会话，基于本地知识库回答产品咨询，必要时调用业务插件或转人工，并把人工解答沉淀回知识库。

| 层面 | 选型 |
| --- | --- |
| 运行时 | 单个 Node 进程（Next.js 16 production server） |
| Web / 后台 | Next.js 16 App Router + React 19 + Tailwind 4 + Base UI / shadcn |
| LLM 编排 | `@anthropic-ai/claude-agent-sdk`（spawn 本地 `claude` CLI 子进程） |
| 存储 | better-sqlite3（WAL）+ `sqlite-vec` 向量检索 |
| 嵌入模型 | 本地 `Xenova/bge-small-zh-v1.5`（512 维，`@huggingface/transformers`） |
| 通道 | `ws`（OneBot 正向 WS）、`grammy`（Telegram） |
| 能力扩展 | Claude Code 插件 + Skill + 本地 MCP server（stdio） |
| 部署 | PM2 fork 单实例 |
| 质量 | TypeScript strict、ESLint、Prettier、Vitest |

关键事实：真实推理模型不是 Claude。所有 Anthropic 模型档在 `data/claude-config/settings.json` 的 `env` 块里被映射到 `MiniMax-M3`，`ANTHROPIC_BASE_URL` 指向 MiniMax 的 Anthropic 兼容端点。模型与中转凭据只存在于该文件，不在 `.env`，后台 UI 也不编辑这三项。

## 2. 目录结构

```text
instrumentation.ts        启动入口：Next.js 起进程时拉起整个 Agent
proxy.ts                  后台鉴权（Next.js proxy，即中间件层）
app/                      App Router：/admin/* 后台页面 + /api/* 路由
components/               后台与通用 UI 组件
lib/
  runtime.ts              RuntimeManager：生命周期、热重启、状态
  assemble.ts             装配全链路，返回 teardown
  bus.ts / events.ts      进程内类型化事件总线与事件契约
  config-store.ts         配置读写（DB 单行 JSON）
  config/                 zod schema、env 种子、形状迁移、白名单规范化
  agent/                  Agent 与全部编排、旁路轮询器
  channels/               通道抽象、注册表、工厂、QQ / TG / mirai 适配器
plugins/
  cs/                     知识库检索插件（kb_search MCP server + Skill）
  packyapi/               可选业务插件示例（实时价格等）
mirai-plugin/             mirai 桥接插件（Kotlin/JVM，独立部署到 mirai 所在机器）
scripts/                  ingest（知识库入库）、db-maintenance（体检/备份）
docs/kb/                  知识库源文件（gitignore）；一级子目录名即分区
data/                     agent.db、claude-config（gitignore，含明文凭据）
logs/                     PM2 与运行日志（gitignore）
tests/                    Vitest，镜像 lib/ 结构
```

约定要点：路径别名 `@/*` 指向仓库根，没有 `src/`。Prettier 无分号 + 双引号。测试只放 `tests/**/*.test.ts`，不与源码同目录。native 依赖列在 `next.config.ts` 的 `serverExternalPackages`，不参与打包。

## 3. 启动机制

整个 Agent 挂在 Next.js 进程里，没有独立的 worker 进程。管住那一个 `next start` 就管住了全部。

`instrumentation.ts` 是唯一启动入口，执行顺序：

1. 判断 `NEXT_RUNTIME !== "nodejs"` 直接返回，保证只在 Node runtime 跑一次。
2. `globalThis.__agentBooted` 单例守卫，防热重载重复启动。
3. `captureConsole()` 接管 console，写入日志缓冲。
4. 临时开一次 DB 读配置（首启从环境变量种子入库），随即关闭。
5. `defaultBuilders()` 动态 import 出 DB、Repo、Agent、assemble 等构造器；native 依赖只在此刻加载，不提到模块顶层。
6. `getRuntime().start(cfg, builders)` 拉起运行时。
7. 若开启预检索，后台异步预热嵌入模型（`embed("预热")`），不阻塞启动。

`RuntimeManager.start()` 的关键动作：

- 把 `CLAUDE_CONFIG_DIR` 与 `DB_PATH` 绝对化写回 `process.env`，供 `claude` CLI 与 MCP 子进程继承。
- 打开进程级共享 DB 连接（`sharedDb`），与 API 路由复用，避免热重启时 in-flight 异步任务撞上已关闭的连接。
- 绑定用量与工具统计持久化，用量超预算时向管理面推送告警。
- 先挂空的 `ChannelRegistry`（`assemble` 闭包会引用它查旁路开关），再 `assemble(...)` 装配全链路，最后 `createChannels` 按工厂表创建并 `startAll()`。

热重启由 `POST /api/runtime/restart` 触发，走 `reconfigure()` = `stop()` + `start()`。`stop()` 依次执行 assemble 返回的 teardown、解绑统计、`stopAll()` 停通道，并对 bus 残留监听器做兜底断言与强制清理。因此改配置不需要重启进程。

生产约束：必须 `pnpm build && pnpm start`，严禁 `next dev`。claude-agent-sdk 要在真实 Node runtime 里 spawn 本地 `claude` 二进制，且 dev 的 HMR websocket 跨 LAN 不稳会挂骨架屏。不支持 edge / serverless 部署。PM2 只能 fork 单实例，不可 cluster（native better-sqlite3 + 单条 WS 长连接）。

## 4. 事件总线：模块解耦方式

`lib/bus.ts` 是一个包了类型的 `EventEmitter` 单例（`globalThis.__prayerBus` 守卫）。所有模块只通过事件通信，互不直接调用，因此每个环节都能单独测试和替换。事件契约定义在 `lib/events.ts`，共 8 个：

| 事件 | 生产者 | 消费者 | 含义 |
| --- | --- | --- | --- |
| `message.received` | 通道适配器 | gateway、message-buffer | 平台原始消息（已 parse/enrich） |
| `message.qualified` | gateway | orchestrator | 通过全部准入门、确认要回答 |
| `reply.ready` | orchestrator、轮询器 | reply-mapper | 待发出的答复文本 |
| `action.send` | reply-mapper、gateway 等 | ChannelRegistry | 出站发送指令 |
| `error.occurred` | 任意模块 | error-handler | 受控错误，可选是否对用户可见 |
| `handoff.requested` | gateway、错误兜底 | handoff-handler | 请求转人工 |
| `handoff.resumed` | handoff-handler、后台 | handoff-handler | 恢复自动答 |
| `resolution.recorded` | 各出站路径 | resolution-recorder | 会话结局打点，供看板统计 |

出站方向只有一个出口：`ChannelRegistry` 独占订阅 `action.send`，按 `payload.channel` 分发到对应适配器。未注册的通道会发 `error.occurred`（scope `channel.unregistered`）而不是静默丢弃。

标识约定在 `lib/channels/ids.ts` 统一生成与解析：`sessionKey = channel:chatId:userId`、`dedupeKey = channel:chatId:messageId`、`chatRef = channel:chatId`。解析时取首段为 channel、末段为 userId、中间全部为 chatId，以兼容 Telegram 的负数 chatId。

## 5. 消息主链路

一条群消息从进入到回复，经过五个阶段。

### 5.1 接入与入库

通道适配器完成平台协议解析（`parse`）与富化（`enrich`：回查引用消息、展开合并转发、下载图片转 base64），然后 emit `message.received`。

两个消费者并行：`gateway` 判定是否要回答，`message-buffer` 把消息落进 `group_messages` 表。注册顺序上 gateway 必须先于 buffer，否则同 tick 内回看前文时会把当前消息也算进去（另有 `excludeMessageId` 作双保险）。

buffer 刻意不过滤 @bot 的消息，因为反思与主题归类需要全量群上下文；它只给消息打 `mentioned_bot` 标记，供主动补位排除。

### 5.2 准入门（gateway）

`registerGateway` 是一串短路判断，顺序如下：

1. 管理面消息：只吃 `!reset <sessionKey>` 与 `!resume <sessionKey>`，绝不进客服流程；无法识别的 `!` 命令回一次用法说明（带去重，防重连重放刷屏），其余静默。
2. 生效会话白名单：不在 `enabledChats` 内的会话完全忽略。
3. 触发判定：需 `botMentioned` 或 `atList` 命中 `botQQ` / `extraAtQQs`，否则不响应。
4. 消息去重：`seenMessage(dedupeKey)` 命中则丢弃。
5. 人工模式：`isHumanMode` 为真时不抢答，仅允许「重置」清上下文。
6. 命令关键词：「重置」清 resume 指针、「帮助」回用法、「人工」发 `handoff.requested`（无管理面时改引导官网）。

通过后拼接上下文：取该用户 @ 之前的近期发言（受 `PRIOR_USER_CONTEXT_LIMIT`、总字数与单行字数三重裁剪）并入正文，记录 `last_question`，最后 emit `message.qualified`。纯 @ 无正文、无图、无前文时回用法说明并记一次 `ack`。

### 5.3 编排（orchestrator）

按 `sessionKey` 维护一条 Promise 链，保证同一用户的消息串行处理；链尾自清理，防止 Map 随历史会话无界增长。

单条消息的处理：

1. `store.touch(sessionKey)` 立即刷活跃时间，让主动补位在 ACK/分类/推理窗口期内看得见「已接管」，避免抢答双发。
2. 若开启 ACK，先发「收到，查询中。」并记 `ack`（不计入解决率分母）。
3. 意图分类：把正文 + 引用 + 转发一起送 `makeIntentClassifier`，命中 `bulk_export` / `meta_probe` 等套取类意图则回模板婉拒、不进 Agent。分类是无自带超时的 LLM 调用，外面套 15s 竞速超时，超时 fail-open 归 `normal`，防中转挂起把整条会话链卡死。
4. `agent.run(text, resumeId, ctx, media)` 推理。
5. 哨兵防护：结果含 `__NO_ANSWER__` 则丢弃续接指针并静默，绝不外发。
6. 有文本则 emit `reply.ready` 并记 `auto`；`sessionId` 回写供下次 resume。

整条链的异常统一转成 `error.occurred` + `resolution.recorded(kind:"error")`，不向上抛。

### 5.4 出站（reply-mapper）

订阅 `reply.ready` 转 `action.send`，是最终出站闸门：整条含哨兵直接吞掉，按 `maxReplyChars`（默认 900）分片后每片再查一次哨兵；分片优先在中文标点处切，切点过前则硬切；只有首片带 `replyToId`。

## 6. Agent 调用机制

`lib/conversation/agent.ts` 封装 SDK 调用，是全项目最需要小心改动的文件。

### 6.1 进程与凭据

SDK 会 spawn 一个 `claude` CLI 子进程。`sdkEnv()` 在传环境变量时剥掉所有继承来的 `ANTHROPIC_*`，因为真实环境变量优先级高于 `settings.json` 的 `env` 块，不剥就会被启动 shell 注入的值 shadow 掉。`CLAUDE_CONFIG_DIR` 与 `PATH` / `HOME` 保留。

后台的 JSON 类任务另走 `configuredSdkEnv()`：只从 `settings.json` 搬运 `env` 字符串（拿到认证、中转地址、模型），不加载 user settings 里的 plugins / skills / hooks，避免面向用户的风格 hook 干扰结构化输出。

### 6.2 两套 query options

`agentQueryOptions`（主客服）：`tools: []` 禁用全部内置工具 schema，`skills: "all"`，`settingSources: ["user"]` 从而由 `enabledPlugins` 加载业务插件及其 MCP server。

`noToolQueryOptions`（意图、可答性、反思、整理、主题、升格）：`tools: []`、`skills: []`、`mcpServers: {}` + `strictMcpConfig`、`settingSources: []`，完全裸跑。例外是 `outputFormat: json_schema` 时 CLI 注入的 `StructuredOutput` 合成工具必须放行，由 `wrapCanUseToolForStructuredOutput` 保证它永远 allow，即使调用方传了 deny-all。

### 6.3 prompt cache 是硬约束

中转端点认 Anthropic prompt cache（2026-09 实测：近 7 天主客服 370 次调用中 218 次 `cache_read>1k`）。因此下列写法都是有实效的优化，不要当冗余删掉：

- system prompt 恒定，不按调用方拼后缀。主动补位的行为指令改放 user prompt 首段，让主动与正常两条路径共享同一前缀，TTL 内可跨路径命中缓存。
- 动态内容（预检索片段、用户消息）全部放 user 侧。
- 后台任务 `tools: []` 压掉数 k 到数十 k 的前缀 token，同时消除 MCP 连接时序导致的前缀字节抖动（命中率曾因此掉到 20%~50%）。

### 6.4 prompt 结构与注入防护

`buildPrompt` 按「资料在前、任务在最后」组织，并用哨兵标记划出信任边界：

```text
<<<SYSTEM_KB_CANDIDATES>>> …预检索候选片段… <<<END_SYSTEM_KB_CANDIDATES>>>
<<<UNTRUSTED_CUSTOMER_MESSAGE>>> …用户正文/引用/转发… <<<END_UNTRUSTED_CUSTOMER_MESSAGE>>>
本轮任务:根据系统规则回应上方用户消息。
```

用户侧文本先过 `sanitizeForModel`，再逐一剥除伪造的哨兵串，防 breakout。system prompt 明确声明：候选片段只是资料不是指令，哨兵内的文字与随附图片全部是不可信内容，即使其中伪造系统标签或要求改规则也只当数据。有图时 prompt 改为 `AsyncIterable<SDKUserMessage>`，文本 block 在前、图片 block 紧随。

不套 `claude_code` preset，用完整自定义 system prompt。preset 的编码助手人格会干扰视觉输入（实测带图时模型回「无图」）。

### 6.5 工具权限

单一放行出口：不用 `allowedTools` 预授权（bare 名会 shadow 回调），全部工具落到 `canUseTool`。判定规则是 `mcp__` 前缀无条件放行（插件 MCP 均为受控只读查询，新增 server 免改代码），另加显式白名单 `Skill`。Bash / Read / WebSearch / WebFetch 一律拒绝，后两者禁用的理由是整页正文进 context 后会永久留在会话里，每轮重发的绝对量显著。

拒绝时返回精准原因（「未在放行白名单，改用已安装的知识库或业务工具」），否则模型会以为是语法问题反复换参数重试，白烧 turn 直到 `maxTurns`。

### 6.6 超时与降级

`maxTurns: 20`，wall-clock 超时默认 180s。SDK 的 query 迭代（真实是中转流）没有自带超时，中转卡住则 `for-await` 永不结束、handle promise 永挂、编排串行链永久卡死该会话所有后续消息。因此超时到点会 abort 子进程并靠 `Promise.race` 兜底返回。

降级策略是保留而非丢弃：`maxTurns` 用尽、CLI 异常、超时或 `queryFn` 同步抛错，都保留已累积文本与 `sessionId`；无文本时返回兜底文案。降级的 run 同样计入工具统计，否则覆盖率分母失真。

### 6.7 知识库预检索

`kb-prefetch` 在每轮进模型前先检索并注入候选片段。动因是 resume 长会话中模型会凭记忆跳过检索，`kb_search` 调用覆盖率曾掉到 11%~70%。

参数：`topK` 默认 5、向量距离上限 1.0、单片段 600 字、检索超时 5s。按 sessionKey 记忆已注入的 chunk id 做跨轮去重（TTL 与 `resumeTtlMs` 对齐，因为去重前提是片段还在模型 context 里），新开会话（含 TTL 过期、哨兵清 resume、主动补位）强制重新注入。全链路 fail-open：检索失败返空串，退回纯 `kb_search` 工具路径。注入块明确声明「候选不是最终依据」，易变业务数据仍须调对应工具。

送去 embed 的 query 会剥掉主动模式的固定指令前缀（约 90 字模板，不剥会主导短问题的向量），并带上引用消息（引用的往往才是真问题）。

## 7. 后台旁路循环

`assemble` 会按配置挂起若干定时任务。它们共享一套设计：`running` 标志防重入、异常只 emit `error.occurred` 不阻断主链路、embed 与 LLM 各自硬超时（60s / 180s，挂起只烧掉本轮）、LLM 调用一律无工具 + `thinking: disabled` + `maxTurns: 2`、结构化输出优先并以文本 JSON 兜底、入模文本全部过 `sanitizeForModel`。

### 7.1 自学习三件套

数据流是一条单向管道：

```text
group_messages
  → reflection-poller  沉淀  → kb_chunks(doc='human-reflection', namespace=来源会话分区)
                                + reflection_meta
  → reflection-compactor 整理 → 按分区分组整批替换（事务内删旧插新 + 存 before/after 快照）
  → reflection-promoter  升格 → docs/kb/promoted/reflection-{id}.md，原反思 chunk 删除
```

全链路限定在同一分区内，详见第 9 节。

**沉淀（reflection-poller）**：默认每 5 分钟扫一次，回看窗口 2 小时，静默期 10 分钟（`until = now - settleMs`，避免抓到还在进行中的对话）。三道门：生效会话、旁路可用、`until > 游标`。band 内没有新的管理员发言就只推游标、不调 LLM。入库前做硬去重，判重需向量距离 ≤ 0.45 **且** 文本相关（bigram Jaccard ≥ 0.35），另有 `textNearlySame` 兜底 embedding 漂移。游标按会话独立、仅成功才推进；解析失败不推进、下轮重试。它还兼职 GC：清理过期的 `group_messages`（下界取主题游标最小值，防未归类提问被提前删）、`resolution_events` 与 `proactive_replies`（90 天）、`seen_messages`（7 天）。

**整理（reflection-compactor）**：持久游标到期式而非纯 interval——判据是 `now - compactAt >= compactMs`（默认 1 小时），因此重启后能补跑；无论成败都在 finally 写回游标，避免反复打 LLM。只处理 `approved` 条目，少于 10 条直接返回，按 30 条分批。写回前三道校验：空集拒绝、暴涨拒绝（超过输入 1.5 倍）、过度删除拒绝（完整产出保留率下限 0.4，截断 salvage 下限 0.2）。单批失败只保留该批原文，不影响其它批。

**升格（reflection-promoter）**：默认 24 小时一次，每轮最多 5 条。候选带上原始问答与权威文档片段做矛盾校验，prompt 要求保守、不确定一律 false。会剔除模型幻觉出的 id。落地顺序是先算向量再进事务（向量失败时 DB 未动可重试），事务内写文档 chunk 并删掉原反思 chunk，避免双份占坑。

**状态机**：`reflection_meta.status` 取 `approved | rejected | promoted`（历史的 `pending` 已迁移为 approved，沉淀即入库、无需人工预审）。检索 SQL 统一过滤 `rejected` 与 `promoted`，所以人工驳回的条目会立刻从检索消失，升格后的条目不与正式文档重复。`rejected` / `promoted` 天然退出循环并保留作审计。

### 7.2 主动补位（unanswered-poller）

无人应答时主动识别未处理问题。默认每 60s 扫一次，静默判定 3 分钟，每轮最多回 2 条。压制规则完整清单：

1. 管理面会话豁免。
2. 通道旁路不可用（如 Telegram 拿不到可靠管理员名单）则跳过。
3. 主动开关关闭：per-chat 策略优先，回落全局开关。
4. 游标沉降：`until <= cursor` 跳过。
5. 冷启动保护：首见会话（`cursor === 0`）只推游标，绝不回答上线前的积压消息。
6. SQL 层预排除：候选不含管理员发言，也不含 `mentioned_bot=1` 的消息（那些归主链路）。
7. 人工已接管：问题时间点之后有管理员发言则跳过。
8. 已处理：`isHumanMode` 为真，或会话活跃时间已晚于问题时间（主链路已答或已兜底）。
9. 可答性门：分类器判为不可答则记 `proactive_silent` 沉默。
10. 哨兵门：`agent.run` 结果为空、命中 `__NO_ANSWER__` 或等于降级兜底文案，一律沉默。
11. 每轮限流：命中上限即 break，且**不推进游标**，溢出的用户靠规则 8 在下轮自然轮到，避免答案被永久丢弃。

安全设计上它故意不 resume 主会话，否则哨兵指令与 `__NO_ANSWER__` 会写进 transcript，后续主链路可能复读并外发；只有产出真答案时才记住新 session。

### 7.3 问题归类（topic-poller）

默认每 5 分钟扫一次、静默 60s。取群成员消息（SQL 已排除管理员与 @bot 消息），带上现有主题 top-40 让模型归类为已有 topicId、新建标题或噪声。剔除越界索引、重复索引与幻觉 topicId；本地再用 `textNearlySame` 在 500 条池内兜底近义合并，防批内与跨群重复新建。整批单事务提交（建主题 + 写 occurrence + 推游标），中途失败整体回滚重跑。空窗口也推游标，防沉默会话把 GC 下界卡在 0。

### 7.4 转人工（handoff-handler）

订阅 `handoff.requested` 置 `human_mode`、记录结局、向管理面推送带 `!resume` 指令的通知（重复请求只回「转接处理中」，不重复通知）。另有 60s 定时扫描超时会话（默认 30 分钟）自动发 `handoff.resumed{by:"timeout"}`，装配时立刻先跑一次防积压。恢复来源区分 `timeout` / `admin` / `ui`。

### 7.5 两个分类器的容错方向相反

`intent`（入站拦截）fail-open：异常或解析失败归 `normal`，因为分类器抖动不该误伤真实用户，system prompt 是第二道防线。`answerability`（主动插话）fail-closed：超时或异常一律判不可答，宁可少发。两者都用定界符包裹并剥离用户伪造的定界符。

## 8. 数据层

`openDb()` 打开 better-sqlite3、启用 WAL、加载 `sqlite-vec` 扩展、跑迁移；任一步失败立即 `close()` 释放文件句柄，避免阻塞修复与恢复。

### 8.1 迁移机制

版本号存在 `PRAGMA user_version`，迁移注册表按严格递增顺序声明（当前到 v10：通道化标识、会话纪元与时间窗索引、机器人提及标记、工具统计、查询索引与主题唯一化、入站消息清理索引、热点读取索引、可靠出站与投递状态、知识库 namespace 分区）。

runner 的保护：每个版本迁移与版本号写入同处一个事务，某步失败则之前版本保留、失败版本不留半成品；版本高于程序支持范围则拒绝打开（不允许旧程序开新库）；不支持降级；步骤必须连续。已升级的库重开时会执行各步的 `repair`，补齐早期版本遗留的缺失结构。

### 8.2 主要表

| 表 | 用途 |
| --- | --- |
| `sessions` | 会话状态：`resume_id`、`human_mode`、`last_question`、活跃时间 |
| `seen_messages` | 消息去重（7 天清理） |
| `group_messages` | 全量入站消息，反思与归类的原料 |
| `kb_chunks` / `kb_vec` | 知识片段与向量（`vec0` 虚拟表，512 维）；`kb_chunks.namespace` 承载分区归属 |
| `reflection_meta` | 反思条目元数据与 `status` 状态机 |
| `reflect_compactions` | 整理前后快照，供后台追溯 |
| `question_topics` / `question_occurrences` | 问题主题与出现记录，支撑排行 |
| `proactive_replies` | 主动补位记录 |
| `resolution_events` | 会话结局打点（auto/ack/blocked/error/proactive/handoff/reset） |
| `usage_daily` / `tool_stats_daily` | 按天用量与工具调用统计 |
| `config` | 配置单行 JSON + 各类游标 |
| `name_cache_*` | 群名、用户名、成员列表缓存 |

数据访问经 `lib/core/db/repo.ts` 聚合的领域仓储（config / knowledge / messages / proactive / reflection / sessions / statistics / tickets / topics）。

### 8.3 检索

`KB_SEARCH_SQL` 是向量近邻查询的唯一事实源：join `kb_vec` 与 `kb_chunks`，限定 `namespace` 等值，左连 `reflection_meta` 并过滤 `rejected` 与 `promoted`，按距离排序。主进程与 cs 插件子进程共用这一常量——此前插件侧有内联副本漏了过滤，导致管理员驳回的错误知识仍会漏给用户。

`searchKb` / `searchBaseKb` 的 namespace 参数必传，不设默认值，避免漏传时静默跨分区。`searchBaseKb` 另外排除 `human-reflection`，供整理与升格取权威文档上下文。

### 8.4 入库

`pnpm ingest` 读 `docs/kb/**`，按空行分段、单段上限 500 字切块，逐块 embed 后写入，按 (namespace, doc) 幂等替换。分区取一级子目录名，根目录散文件归 `default`（规则在 `lib/knowledge/kb-path.ts` 的 `namespaceOfRel`，ingest 与 kb API 共用）。

prune 按 (namespace, doc) 联合判定，不能只看 doc 名——不同分区允许同名文件，只看 doc 会误删。`human-reflection` 这类只存在于 DB、磁盘无对应文件的 doc 在 prune 时受保护。CLI 与 `POST /api/kb/ingest` 通过 `globalThis` 上的进程级互斥锁串行化，防止并发时两个循环对同一 doc 交错 delete/insert 混入双方 chunk。

## 9. 知识库分区（多租户隔离）

一个会话只对应一份知识库，租户之间无公共知识。`kb_chunks.namespace` 承载归属，多个会话可填同一值以共用一份知识库。

### 9.1 映射与解析

映射落在 `groupPolicies.<channel:chatId>.kbNamespace`，复用既有的 per-chat 策略位置，不新建映射表。解析统一走 `lib/core/chat/enabled-chats.ts` 的 `resolveKbNamespace`，全项目唯一入口，禁止各调用点自行拼装；它内部复用 `getGroupPolicy`，因此连带获得 QQ 裸群号 legacy 键兼容。

未配置回落 `DEFAULT_KB_NAMESPACE`（`"default"`）。这是存量兼容所必需的，但多租户下漏配等于读到 default 分区（含存量语料），是本功能唯一的跨租户泄漏面。因此 `chatsMissingKbNamespace` 列出「已生效但未配」的会话，后台在 `/admin/groups` 的指标区、表格列与策略弹窗三处显式告警，而不是让默认值静默生效。管理面不参与告警，它不进客服流程也不检索知识库。

### 9.2 MCP 子进程如何拿到分区

这是设计上最需要注意的一环。`kb_search` 跑在独立 MCP 子进程里，只收模型传的 `query`，本来无从知道当前是哪个会话在问。

解法是 per-run env 注入：SDK 每次 `query()` 都 spawn 全新 CLI 子进程，`agentQueryOptions` 的 `env` 是每次调用传入的，所以 `agent.run` 把 `KB_NAMESPACE` 塞进 env，cs-mcp 像读 `DB_PATH` 一样读它。

没做成工具参数，因为那等于让模型自己声明查哪个租户——模型可能传错，也可能被提示注入诱导跨租户检索。env 注入模型无感、无法伪造。env 变化不进 prompt，不影响缓存前缀。

### 9.3 旁路的分区行为

沉淀按来源会话所属分区写入，去重检索也限定该分区（跨分区去重会把别的租户已有知识误判成重复而丢弃本条）。

整理与升格按分区分组、逐组独立跑 LLM，`minEntries` 按组判定。游标 `compactAt` / `promoteAt` 仍是全局单份，一次 tick 内走完所有分区。这会让 LLM 调用次数随分区数增长，`usageBudgetUsd` 告警可覆盖。

整理后的条目不再对应单一来源 chat，因此 source 记 `human-reflection:ns=<分区>:<ts>`，`channel` / `chatId` 解析为 null（此前硬编码 `qq:0` 是编造归属），但 `ts` 是真实整理时间必须保留。`reflect-stats` 按会话统计沉淀数时跳过这类无来源条目。升格沿用原条目分区——升格只是把知识固化成文档，归属不变。

## 10. 通道层

`Channel` 接口约定平台 IO 与协议映射：`start` / `stop` / `isConnected` / `status` / `send`，可选 `isBypassEnabled`、`listChats`、`listMembers`、`resolveChatTitle`。入站自行 parse/enrich 后 emit `message.received`，出站只由 registry 调用，Agent 侧不得 import 任何平台实现。

每个通道声明自己的 `capabilities`（能否列群、列成员、下载媒体、支持管理命令、旁路管线是否可靠），上层按能力决定行为而不是按 `if channel === "qq"` 硬判。

新增通道 = 在 `DEFAULT_CHANNEL_FACTORIES` 加一行 + 实现 adapter。工厂返回 `null` 表示该通道未配置（QQ 看 `onebotWsUrl`，TG 看 `telegramBotToken`，mirai 看 `miraiWsEnabled` 且有凭据），不注册。`discord` 目前只预留类型，无生产适配器。

`CHANNEL_IDS`（`lib/channels/types.ts`）是通道枚举的唯一来源，`lib/channels/ids.ts` 的解析集合由它派生，zod 的 `chatRefSchema` 也用它，因此加值只需改一处。注意不同通道的 sessionKey 是不同的键：`mirai:群号:QQ号` 与 `qq:群号:QQ号` 互不相通，会话上下文、`kbNamespace` 配置、沉淀归属都不会自动迁移。

**QQ / OneBot**：正向 WebSocket 连 NapCat。带指数退避重连、echo 请求-响应（`get_msg` / `get_forward_msg` 回查引用与合并转发）、30s 主动 ping 与静默看门狗——未观察到心跳时以 75s 为兜底 deadline，收到 NapCat 心跳后按其 interval × 3 动态 retune（容忍连丢 2 个心跳），判定静默即强制重连并计数。未连接时发送会丢弃但记 warn，让运维侧至少可见。

**Telegram**：grammy long polling，offset 持久化在 config 表。额外处理管理员名单缓存、Privacy Mode 启发式判定；拿不到可靠管理员名单时 `isBypassEnabled` 返回 false，从而关掉该会话的反思、归类与主动补位（这些都依赖可靠的 `senderRole` 与全量消息）。

**mirai**：方向与前两者相反——Prayer 作 WS **服务端**，远程 mirai 插件作客户端主动连入，因此插件所在机器无需公网。用于把 QQ 接入与知识库分机部署。

服务端起在独立端口（默认 3002；3000 是 Next.js，3001 是 NapCat 的常用地址，同机占用会 EADDRINUSE）。不复用 3000 是因为 App Router 的 route handler 拿不到底层 socket 做 upgrade，而自定义 server 接管 upgrade 又要放弃 `next start`，与 PM2 部署方式冲突。

鉴权在 `verifyClient` 阶段完成并直接拒绝握手：读 `Authorization: Bearer` 或 `Sec-WebSocket-Protocol`（后者供不能设 header 的浏览器类客户端），用 `timingSafeEqualStr` 逐个比对 `miraiWsClients` 的 per-client 凭据。**无凭据时拒绝监听**——开放的 WS 端口等于任何人都能让机器人在群里发言。绝不复用 `ADMIN_TOKEN`。

服务端维护 `chatId → clientId` 路由表（来源是插件 `hello` 帧上报，以及首次收到该会话消息时补建），出站按此选连接。同 clientId 允许多连接（客户端重启期可能短暂重叠），出站时全部下发。心跳每 30s ping，75s 未收到任何入站帧即断开该连接，避免半开连接长期占着路由表。

入站帧全部经 zod 校验（`lib/channels/mirai/protocol.ts`）。对端是独立进程、独立语言栈，不能假定它守约：畸形帧只丢弃并记 warn，绝不允许崩掉服务端（会连带断掉其它 client）。`messageId` 由插件用 `MessageSource.ids` 拼出且必须稳定，Prayer 侧据此 `seenMessage` 去重，因此插件重连重放不会导致重复回答。`botMentioned` 也由插件判定后显式上报，保持与 QQ 群一致的「@ 才答」语义。

`startAll` 用 `allSettled`，单通道启动失败不回滚其它通道，失败原因写入该通道 `lastError` 并在后台状态里可见。

## 11. 插件、Skill 与 MCP

业务能力不写进客服主流程，而是通过 Claude Code 插件接入。加载路径唯一：`CLAUDE_CONFIG_DIR/settings.json` 的 `enabledPlugins`（配合 `settingSources: ["user"]`），代码不显式传 `pluginPaths`，避免双加载冲突。

`plugins/cs` 提供知识库检索：一个 stdio MCP server 暴露单工具 `kb_search`，以及一个 Skill 提供使用说明。它以只读方式打开同一个 WAL 库（`DB_PATH` 由父进程绝对化后继承），不建表不迁移。子进程由 Node 原生 strip-only 运行 TypeScript，因此不能 import `lib/core/db/repo.ts`（TS 参数属性不被支持），只复用 `lib/model/embed.ts` 与 `lib/knowledge/kb.ts`。

`plugins/packyapi` 是可选业务插件示例（实时价格等）。启用它能查 PackyAPI 实时数据，停用或替换不影响平台身份。

后台的插件管理器通过 `execFile` 调 `claude plugin` CLI 管理 `enabledPlugins` 与 cache。安全措施：不经 shell、插件引用名做字符白名单校验（纵深防御 + 早失败）、30s 超时后 SIGKILL，防 CLI 卡住时整个插件管理 API 悬挂。

## 12. 配置机制

`lib/core/config/schema.ts` 的 zod schema 是配置字段、默认值与类型的唯一来源，不引入数据库或运行时依赖。整份配置以单行 JSON 存在 `config` 表的 `app` 键。

读取流程（`getConfig`）：先从环境变量算出种子，DB 无值 / JSON 非法 / 不是对象时写入种子并返回；否则跑形状迁移，迁移过就写回。写入（`setConfig`）会过滤 `undefined`（未修改不等于重置为默认值）并规范化白名单与管理面等 SOT 字段。

定时器类字段做了上下限约束（Node 定时器超过 2^31-1 会退回 1ms），`0` 明确表示关闭。敏感字段（如 OneBot access token）在后台以掩码显示，回写时若仍是掩码串则保留旧值。模型与中转凭据不由本程序读写，只在 `settings.json` 里手工维护。

环境变量只作首次种子，之后以数据库为准，绝大多数参数可在 `/admin/config` 改并热重启生效。

## 13. 管理后台

`app/admin/*` 提供概览、会话、人工队列、知识库、反思、问题排行、主动补位、群组、能力、插件、日志、配置等页面，对应 `app/api/*` 路由。

per-chat 策略（主动补位、静默阈值、转人工通知、知识库分区）在 `/admin/groups` 的策略弹窗里编辑，未覆盖的项跟随全局。分区漏配告警也在该页（指标区计数 + 表格列标记）。`/admin/kb` 的统计行按分区汇总：单分区时只标分区名，多分区才列出各分区分块数。

鉴权在 `proxy.ts`，匹配 `/admin/*`、`/api/*`、`/login`。行为是 fail-closed：未设置 `ADMIN_TOKEN` 时开发环境放行，生产环境全部拒绝（API 返 403、页面返 503）。此前的「未设即不鉴权」会让漏配的生产实例把日志、聊天记录、配置修改与运行时重启全部静默公开，因此改为拒绝服务优于静默裸奔。设置后校验 Cookie `admin_token` 或 Header `x-admin-token`，比较用时间恒定函数；`/login` 与登录接口放行。

## 14. 部署与运维

```bash
pnpm dev                 # 仅开发后台 UI
pnpm build && pnpm start # 生产
pnpm pm:start            # 构建并交给 PM2
pnpm check               # typecheck + lint + test
pnpm ingest              # 知识库入库
pnpm db:check / db:backup
```

PM2 直接调 `next` 二进制而非经 pnpm 包一层子进程，以便停止时能精确杀到 node 进程；fork 模式、单实例、1G 内存上限自动重启、日志落 `logs/`。`pm:enable` / `pm:disable` 是 Linux systemd + sudo 路径，macOS 开发机不适用。

验证构建不要覆盖在跑实例的产物：`next start` 直接服务 `.next`，本机实例还在跑时用 `NEXT_DIST_DIR=.next-verify pnpm build`。

## 15. 修改代码前需要知道的约束

- 生产禁用 `next dev`；不支持 edge / serverless / Vercel。
- PM2 不能 cluster；进程内单例（bus、runtime、DB 连接）都假定单进程。
- system prompt 保持恒定、动态内容放 user 侧、后台任务保持 `tools: []`，这些是 prompt cache 优化，不是冗余代码。
- 所有出站路径必须过哨兵检查，`__NO_ANSWER__` 绝不能发给用户。
- 检索 SQL 只有一份（`KB_SEARCH_SQL`），不要在插件侧复制。
- 知识库分区解析只走 `resolveKbNamespace`，路径到分区只走 `namespaceOfRel`；不要在调用点自行拼装或推断。
- 分区绝不能交给模型声明（工具参数、prompt 变量都不行），只能由服务端经 env 注入。
- 新增知识写入路径必须显式传 namespace；`insertKbEntry` / `insertKbChunk` 故意不设默认值，漏传应当编译报错而不是静默落进 default。
- 改 Agent 核心、DB schema 或后台反思循环前先出方案。功能分支开发，提交用 Conventional Commits + 中文正文。
- Next.js 16 与既有认知有差异，写代码前先读 `node_modules/next/dist/docs/`。

## 16. 附：作为独立 Web 服务对接外部消息

结论：可以，但不是开箱可用。进程本身已经是 Web 服务，Agent 核心也是通道无关的，缺的只是入站 HTTP 接口。

### 15.1 现状差距

| 卡点 | 现状 | 影响 |
| --- | --- | --- |
| 无入站消息接口 | `app/api/*` 全是后台管理用途，`message.received` 只由 QQ、TG 适配器 emit | 外部系统无法投递消息 |
| 入口均为出向连接 | QQ 主动连 NapCat 正向 WS；TG long polling | 两者都不配置时进程照样起，但无任何消息 IO，等于空转 |
| 通道 id 封闭 | `CHANNEL_IDS = ["qq","tg","discord"]`，`ids.ts` 另有一份硬编码副本，schema 直接 `z.enum(CHANNEL_IDS)` | 新增通道需同时改类型、解析器与配置校验 |
| 回复无请求关联 | 全链路 fire-and-forget，`ActionSend` 只有 `channel/chatId/text/replyToId`，无 `requestId` | HTTP 请求拿不到「这条回复属于我」的凭据 |
| 一问多条出站 | ACK 与正式答复是两条独立 `reply.ready`，再按 900 字分片 | 同步返回需决定等哪一条、等多久 |

### 15.2 改造方案（回调式，推荐）

| 要做什么 | 怎么做 | 达成效果 |
| --- | --- | --- |
| 放开通道枚举 | `CHANNEL_IDS` 增加 `http`；同步 `ids.ts` 内的 `CHANNELS` 副本 | 配置、白名单、sessionKey 解析接受新通道 |
| 实现 HttpChannel | 实现 `Channel` 接口，`send()` 把回复 POST 到该集成配置的回调地址；`capabilities` 中 `supportsMemberList`、`supportsGroupList` 置 false | 出站复用 registry 统一分发，不改主链路 |
| 注册进工厂表 | 在 `DEFAULT_CHANNEL_FACTORIES` 加一行，无回调地址配置时返回 `null` | 未配置即不注册，与现有通道语义一致 |
| 新增入站路由 | `POST /api/channels/http/messages`，校验入参后转成 `IncomingMessage` emit 上总线，立即返 202 | 打通入站，全部准入门与串行链免费复用 |
| 绕过 @ 触发 | 构造消息时置 `botMentioned: true` | 单聊场景无需 @ 即可响应 |
| 独立鉴权 | 为集成方单独发放 per-integration 凭据，不复用 `ADMIN_TOKEN` | 对外接口与后台管理权限隔离 |
| 幂等约定 | 要求调用方传稳定 `messageId`，由 `seenMessage(dedupeKey)` 去重 | 重试不会导致重复回答 |
| 配置项与页面 | schema 增加回调地址与凭据字段，`/admin/config` 暴露 | 可热重启生效，无需改代码 |

改完即可获得：外部系统 POST 消息进来，Agent 按知识库作答并回调送出，同时自动获得会话上下文、意图拦截、转人工、反思沉淀、用量统计与后台可观测性。

### 15.3 两种对接方式对比

| 维度 | 回调式 | 同步式 |
| --- | --- | --- |
| 交互 | POST 进、202 返回，答复回调送出 | 单次 HTTP 请求内返回答复 |
| 改动范围 | 顺着现有架构，不动 bus 契约 | 需在事件契约贯穿 `requestId`，通道侧维护 pending 表 |
| 主要难点 | 集成方需提供可达回调地址 | 一问多条出站；Agent 单次超时 180s，长连接不合适 |
| 适用 | 服务端对服务端、企业 IM、工单系统 | 网页挂件等必须同步返回的场景 |
| 建议 | 先落地这条 | 验证后按需追加 |







