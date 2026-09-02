# CF-Workers-TGUnbanBot

基于 Cloudflare Workers 的 Telegram 群组自助解封机器人。机器人会通过 Telegram Webhook 接收消息，帮助被封禁或被禁言的用户在私聊中完成自助解封流程，同时提供管理员黑名单、封禁记录查询和新入群机器人风控能力。

## 功能

- `/start`、`/unban`：向用户展示自助解封说明。
- 用户发送指定确认文本后，自动检查其群内状态，并尝试解除封禁或禁言。
- 管理员私聊或在被管理群组内发送 `/ban 用户ID`：将用户加入本地黑名单（数据库版存 D1，未绑定 D1 时自动回退 KV）；在被管理群组内使用时会同步禁言该用户。
- 管理员私聊或在被管理群组内发送 `/unban 用户ID`：将用户移出本地黑名单，并同步解除其在被管理群组里的封禁或禁言。
- 管理员在被管理群组内回复用户消息发送 `/ban` 或 `/unban`：对被回复用户执行对应的黑名单操作；`/ban` 会同步禁言该用户，`/unban` 会同步解除封禁或禁言。
- 管理员在群内回复用户消息发送 `/spam`：将被回复用户加入本地黑名单。
- 管理员发送 `/check 用户ID`，或在群内回复用户消息发送 `/check`：查询用户的 GKY 封禁记录与本地黑名单状态（数据库版附带本地封禁原因与时间），并返回二次审核操作提示。
- `/ad`（隐藏命令，不出现在命令菜单）：群内回复某条消息发起举报投票，把被举报消息内容与**被举报人的昵称/用户名/简介**一起交给 Workers AI（默认 `@cf/openai/gpt-oss-20b`，可用 `AD_AI_MODEL` 更换）按群规判断威胁评级（广告可能把内容藏匿于昵称简介中，故一并纳入判断），评级决定本次投票生效阈值（赞成票数）：🔴 A 高危 2 票、🟡 B 危险 4 票、🟢 C 可疑 6 票、🔵 D 未知 8 票；**反对票阈值 = 10 − 赞成票阈值**（A 反 8 票、B 反 6 票、C 反 4 票、D 反 2 票），任一边先到即结束；发起人自己点『反对』即视为放弃举报，投票立即关闭（不执行任何处理）。AI 有响应但无法识别/拒绝答复（如安全策略拒答、格式错乱）时按 🟡 B 危险（4 票）处理；无消息内容且未获取到用户资料、或 AI 调用失败时按 🟢 C 可疑（6 票）处理。群规可通过 `AD_GROUP_RULES` 环境变量自定义。投票通过后，为避免广告号显示名称（含 @用户名）中的广告内容二次传播，被举报人名称将自动脱敏显示（仅保留首尾字符）。**普通用户**在群内回复消息发送 `/ad` 也可发起举报：内容交 AI 评级，仅 A/B（高危/危险）评级会弹出投票，C/D 或 AI 不可用时完全静默；群组**助推者**（Telegram Boost）或 `/add_ad_admin` 白名单成员可与管理员一样直接发起投票。
- `/add_ad_admin 用户ID`、`/del_ad_admin 用户ID`（管理员私聊）：管理"热心群友"举报白名单——白名单成员可在群内直接发起 `/ad` 举报投票。
- `/banlist?tgid=用户ID`：代理查询并解析 `gkybot.gmeow.cc` 的封禁记录。
- 新机器人进群时，如果不是管理员，自动禁言该机器人。
- **联网黑名单自动查杀**（非 `GROUP_ID` 群）：当 bot 加入其他群且仍是该群管理员（administrator/creator，且具备"限制成员"权限）时自动启用。新 TGID 自动建档（`active_group_ids` 记录本群 + 状态"健康"）；存量用户在本群状态为"健康"且命中联网黑名单（`is_blacklisted=1`）时自动禁言，同步本群状态为"禁言"，并在群内通知（附"🔨 永久封禁 / ✅ 加入白名单"按钮，仅本群管理员可点）。点"永久封禁"→ 踢出 + 本群状态"封禁"；点"加入白名单"→ 解除封禁/禁言 + 本群状态"白名单"（本群豁免，不再自动查杀）。
- 非 `GROUP_ID` 群内（bot 为该群管理员时），管理员同样可使用 `/ban`、`/spam`、`/unban`：`/ban` 标记本群状态"封禁"并封禁踢出；`/spam`（回复）标记本群状态"禁言"并禁言；`/unban` 标记本群状态"白名单"并解除封禁/禁言。这三个命令在非 `GROUP_ID` 群内**不会**修改 `is_blacklisted`（联网黑名单）；联网黑名单只能由 `GROUP_ID` 群内的 `/ad`、`/ban`、`/spam`、`/unban` 修改。

## 项目结构

```text
.
├── _worker.js       # Worker 主程序
├── wrangler.toml    # Cloudflare Wrangler 配置
├── README.md
└── LICENSE
```

## 前置条件

- 一个 Telegram Bot Token，可通过 [@BotFather](https://t.me/BotFather) 创建机器人获取。
- 一个 Cloudflare 账号，并启用 Workers。
- 本地安装 Node.js 和 Wrangler，或直接使用 Cloudflare 控制台部署。
- 机器人需要被加入目标群组并设为管理员。

建议给机器人以下权限：

- 封禁用户或解除封禁
- 管理员权限或限制成员权限
- 读取群成员状态
- 发送消息

## 环境变量

Worker 启动时会检查以下变量，缺失会直接返回错误：

| 变量名 | 必需 | 说明 |
| --- | --- | --- |
| `TOKEN` | 是 | 初始化入口密钥。访问 `https://你的Worker域名/TOKEN` 时会设置 Telegram Webhook 和机器人命令。建议使用随机长字符串。 |
| `BOT_TOKEN` | 是 | Telegram Bot Token。 |
| `GROUP_ID` | 是 | 目标 Telegram 群组 ID，一般是负数，例如 `-1001234567890`。 |
| `KV` | 否 | Cloudflare KV 绑定名，绑定名必须是 `KV`。**数据库版（推荐）下作为旧数据迁移源**：首次部署绑定 D1 后会自动把 KV 中已有的黑名单/白名单导入数据库；未绑定 D1 时作为黑名单的运行时存储（旧行为）。 |
| `DB` | 否 | Cloudflare D1 数据库绑定名，绑定名必须是 `DB`。**数据库版数据层**：黑名单、/add_ad_admin 白名单、用户记录（资料/最后对话时间/活跃群组及群内状态/消息计数）均存 D1；未绑定 D1 时自动回退 KV 模式。首次启用时会自动建表并把 KV 旧数据导入一次（幂等）。 |
| `AD_GROUP_RULES` | 否 | `/ad` 举报投票时 AI 判断威胁评级所用的群规文本。默认值为 `禁止讨论涉及涉政、NSFW、引战、嘲讽引战、广告推销、邪教`。 |
| `AD_VOTE_THRESHOLD` | 否 | `/ad` 举报投票在无可判断内容（无消息且未取到用户资料）/ AI 调用失败时的回退赞成票数。默认 6（即 🟢C 可疑）。AI 评级生效时，赞成票数由评级决定（A=2 / B=4 / C=6 / D=8），反对票数恒为 `10 − 赞成票数`（A=8 / B=6 / C=4 / D=2），该变量不参与；AI 有响应但无法识别/拒答时固定按 🟡B 危险 4 票（反对 6 票），也不受该变量影响。 |
| `AD_AI_MODEL` | 否 | 威胁评级使用的 AI 模型。默认 `@cf/openai/gpt-oss-20b`（实测延迟约 2 秒、稳定性好）。可用 `@cf/zai-org/glm-4.7-flash` 或 `@cf/qwen/qwen3-30b-a3b-fp8` 等替换，改后重新部署生效。 |
| `AD_AI_TIMEOUT_MS` | 否 | AI 单次调用超时毫秒数，默认 `12000`。超时/异常时回退 🟢C 可疑（12 秒 + 发送消息，在 Worker 30 秒墙钟上限内）。 |

KV 中会使用 `blacklist` 这个 key 保存本地黑名单数组（数据库版下仅作迁移源，迁移完成后不再读写）。`ad_vote:<token>` 保存 `/ad` 举报投票状态（7 天 TTL，始终存 KV，利用 TTL 自动过期）。

### 数据库版数据存储（D1）

绑定 D1 后，`users` 表以 `tgid` 为唯一标识记录所有收到消息的用户，字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tgid` | TEXT (PK) | 用户唯一标识 |
| `first_name` / `last_name` / `username` | TEXT | 资料快照（每次收到消息自动刷新） |
| `is_bot` | INTEGER | 是否机器人 |
| `is_blacklisted` | INTEGER | 是否在本地黑名单（0/1） |
| `ban_reason` | TEXT | 黑名单原因：`举报`（/ad 投票通过）、`管理员封禁(/spam)`、`管理员封禁(/ban)` |
| `banned_at` | INTEGER | 黑名单时间（epoch 秒；0 = 未知，KV 导入的旧数据无时间时为 0） |
| `banned_by` | TEXT | 封禁处理人 tgid（溯源）：/ad 存举报发起人，/spam、/ban 存操作管理员 |
| `can_report` | INTEGER | 举报资格（/add_ad_admin 白名单，0/1） |
| `is_gky_blacklisted` | INTEGER | 是否在 GKY 黑名单（/check 查询 GKY 有封禁记录时自动标记，0/1，后期备用） |
| `last_active_at` | INTEGER | 最后对话时间（epoch 秒） |
| `active_group_ids` | TEXT | 活跃群组数组（JSON），元素为 `{id, status}`，status 五态：`管理员`/`健康`/`禁言`/`封禁`/`白名单`。如 `[{"id":"-1001","status":"健康"},{"id":"-1002","status":"封禁"}]`；兼容旧格式纯 ID 字符串数组（读时按"健康"处理） |
| `created_at` | INTEGER | 首次记录时间 |
| `last_unban_at` | INTEGER | 上次解封时间（0 = 从未解封） |
| `unbanned_by` | TEXT | 解封处理人 tgid（溯源）：/unban 存操作管理员，自助解封存用户本人 |
| `message_count` | INTEGER | 收到消息总数 |

数据流：**数据库版优先**——绑定 D1 后所有读写走数据库；未绑定 D1 自动回退 KV（完全兼容旧行为）。首次启用 D1 时自动执行一次性迁移：KV 中的黑名单/白名单导入 `users` 表，缺失的时间字段填默认值 `0`（未知），迁移带互斥锁、幂等且失败自动重试。

### 群组状态标记（active_group_ids 三态）

`active_group_ids` 记录用户活跃过的群组，以及当前账号在**对应群组**内的状态，三态语义：

| 状态 | 含义 | 标记场景 |
| --- | --- | --- |
| `健康` | 正常成员（含管理员/群主，可发言） | 用户在群内发消息自动刷新；`/unban` 或自助解封恢复成功 |
| `禁言` | 被禁发消息（restrictChatMember） | `/ban` 在群内禁言成功；`/ad` 投票通过且用户在群内被禁言；联网查杀命中联网黑名单禁言；非 GROUP_ID 群 `/spam` |
| `封禁` | 被踢出群组（banChatMember） | 黑名单用户入群被拦截封禁；`/ad` 投票通过且用户不在群内被永久封禁；联网查杀按钮"永久封禁"；非 GROUP_ID 群 `/ban` |
| `白名单` | 被本群管理员显式豁免，不再触发联网查杀 | 联网查杀通知点"加入白名单"；非 GROUP_ID 群 `/unban` |
| `管理员` | 群主/管理员（豁免查杀） | 管理员发言自动标记（GROUP_ID 管理员） |

标记规则：

- 仅在群内操作**成功**后写入状态，操作失败不标记（避免误记）。
- 用户在群内再次发消息时，其在该群的状态自动刷新为 `健康`（能发言即健康，之前被标记禁言/封禁的用户恢复发言后自动回正）。
- 旧数据（纯 ID 字符串数组）读取时按 `健康` 兼容，不迁移不报错；写入新状态后自动升级为新格式。
- 未绑定 D1（KV 模式）不维护该字段；查询用户未记录过的群返回 `null`（未记录 ≠ 健康）。

## 部署

### 1. 安装依赖工具

本项目没有 npm 依赖，只需要 Wrangler：

```bash
npm install -g wrangler
wrangler login
```

### 2. 创建 KV namespace

如果要使用 `/ban`、`/unban 用户ID`、`/spam` 这些本地黑名单功能，需要创建 KV（**推荐同时创建 D1，见 2.1；绑定 D1 后 KV 仅作一次性迁移源**）：

```bash
wrangler kv namespace create KV
```

将输出里的 `id` 写入 `wrangler.toml`。当前项目的 `wrangler.toml` 已经预留了 KV 配置模板：

```toml
#[[kv_namespaces]]
#binding = "KV"                          # KV 绑定名默认不可修改
#id = "40ff47946cdd4ade8856158cec511e3f" # KV 数据库 id
```

使用时取消注释，并把 `id` 替换为你自己创建的 KV namespace id：

```toml
name = "TG-Unban-Bot"
main = "_worker.js"
compatibility_date = "2026-05-19"
keep_vars = true

[[kv_namespaces]]
binding = "KV"
id = "你的 KV namespace id"
```

这里的 `binding = "KV"` 必须保持不变，因为源码通过 `env.KV` 访问 KV。如果改成其他绑定名，`/ban`、`/unban 用户ID`、`/spam` 会无法读写黑名单。

如果不绑定 KV，自助解封和 GKY 封禁查询仍可运行，但本地黑名单相关命令会提示未绑定存储。

### 2.1 创建 D1 数据库（推荐，数据库版）

数据量增长后 KV 读写会成为瓶颈，推荐绑定 D1 使用数据库版：黑名单/白名单/用户记录存数据库，且首次启用时自动把 KV 旧数据导入（无需手动迁移）。

```bash
wrangler d1 create tg-unban-bot
```

将输出里的 `database_id` 填入 `wrangler.toml`（取消注释）：

```toml
[[d1_databases]]
binding = "DB"
database_name = "tg-unban-bot"
database_id = "你的 D1 database_id"
```

`binding = "DB"` 必须保持不变，源码通过 `env.DB` 访问数据库。重新 `wrangler deploy` 后，首个请求会自动完成：

1. 建表（`users` 用户表 + `schema_meta` 迁移标记表，幂等）；**已上线的旧数据库会自动补齐新增列**（如 `banned_by`、`unbanned_by`、`is_gky_blacklisted`，通过 `ALTER TABLE ADD COLUMN`，旧数据不丢）；
2. 检查 KV 中是否还有未导入的旧黑名单/白名单，有则自动导入一次（带互斥锁，并发安全；KV 读取失败自动重试，不丢数据）；
3. 导入的旧黑名单缺少时间字段时填默认值 `0`（未知），避免数据错误。

若未绑定 D1，所有功能自动回退纯 KV 模式（旧行为完全不变）。

### 2.2 启用 Workers AI 绑定（/ad 威胁评级功能）

`/ad` 举报投票的威胁评级依赖 Workers AI。在 `wrangler.toml` 中已预留配置：

```toml
[ai]
binding = "AI"
```

在 Cloudflare Dashboard 中确保该 Worker 已绑定名为 `AI` 的 Workers AI 资源（也可以直接在 `wrangler.toml` 保留 `[ai]` 配置后重新 `wrangler deploy`）。若未绑定或调用失败，`/ad` 会自动回退为 🟢C 可疑（6 票）；若 AI 有响应但内容无法识别或拒绝答复（如触发安全策略），则按 🟡B 危险（4 票）处理，均不影响投票功能本身。

### 3. 可选：配置 Observability 日志

Cloudflare Worker 后台可能会提示你在 `wrangler.toml` 中添加 Observability 配置，用来控制 Worker 日志、调用记录和链路追踪。这个配置不是机器人运行的必需项，但强烈建议至少开启 `logs`，因为本项目会通过 `console.log()` 输出 Telegram 更新、权限检查、API 返回等调试信息。

示例配置：

```toml
[observability]
enabled = false
head_sampling_rate = 1

[observability.logs]
enabled = true
head_sampling_rate = 1
persist = true
invocation_logs = true

[observability.traces]
enabled = false
persist = true
head_sampling_rate = 1
```

各参数含义：

| 配置项 | 说明 |
| --- | --- |
| `[observability]` | 顶层 Observability 配置。Cloudflare 后台生成的细分配置中，可以在这里保留全局默认值，再分别用 `logs` 和 `traces` 控制具体功能。 |
| `enabled` | 是否启用对应层级的可观测性功能。`[observability.logs] enabled = true` 表示启用日志；`[observability.traces] enabled = false` 表示关闭链路追踪。 |
| `head_sampling_rate` | 采样率，范围是 `0` 到 `1`。`1` 表示 100% 请求都采集，`0.1` 表示采集 10%，`0.01` 表示采集 1%。 |
| `[observability.logs]` | Workers Logs 配置，用于在 Cloudflare 后台查看请求日志、`console.log()`、错误和异常。 |
| `persist` | 是否把日志或追踪数据保存到 Cloudflare 后台。`true` 方便后续查询；`false` 通常用于只导出到第三方日志平台的场景。 |
| `invocation_logs` | 是否记录每次 Worker 调用的基础日志，例如请求方式、URL、响应状态、耗时等。关闭后通常还能看到代码中主动输出的日志，但少了每次调用的基础记录。 |
| `[observability.traces]` | 链路追踪配置，用于分析一次请求内部的调用链和耗时。本项目通常不需要开启，排查复杂性能问题时再打开即可。 |

采样率建议：

- 个人或低流量使用：`head_sampling_rate = 1`，所有请求都记录，排查问题最方便。
- 中等流量：可以设为 `0.1`，只记录约 10% 请求。
- 高流量或担心日志额度/费用：可以设为 `0.01` 或更低。
- 如果正在排查线上问题，可以临时调高到 `1`，处理完再降回去。

如果你只想看机器人日志，推荐保持：

```toml
[observability.logs]
enabled = true
head_sampling_rate = 1
persist = true
invocation_logs = true

[observability.traces]
enabled = false
```

修改后需要重新部署：

```bash
wrangler deploy
```

### 4. 设置环境变量

```bash
wrangler secret put TOKEN
wrangler secret put BOT_TOKEN
wrangler secret put GROUP_ID
```

也可以在 Cloudflare Dashboard 的 Worker 设置页中添加同名变量。

### 5. 部署 Worker

```bash
wrangler deploy
```

部署后记录 Worker 域名，例如：

```text
https://tg-unban-bot.example.workers.dev
```

### 6. 初始化 Webhook

访问下面的地址：

```text
https://你的Worker域名/你的TOKEN
```

成功后会自动完成：

- 设置 Telegram Webhook 到 Worker 根路径 `/`
- 设置机器人命令：`/unban`、`/ban`、`/spam`、`/check`

返回 JSON 中 `成功: true` 即表示初始化完成。

## 使用方法

### 用户自助解封

1. 用户私聊机器人发送 `/start` 或 `/unban`。
2. 机器人返回自助解封说明。
3. 用户按提示发送：

```text
我不是广告狗，我是误封的，希望可以解封。
```

4. 机器人会检查用户在 `GROUP_ID` 群内的状态：
   - 如果用户被封禁，调用 `unbanChatMember` 解封。
   - 如果用户被禁言，调用 `restrictChatMember` 恢复发言权限。
   - 如果用户存在 GKY 封禁记录，会在群内提醒管理员进行二次审核。

### 管理员命令

| 命令 | 使用位置 | 说明 |
| --- | --- | --- |
| `/ban 用户ID` | 私聊机器人或被管理群组 | 将用户加入本地黑名单（D1 优先，未绑定回退 KV）；在被管理群组内使用时同步禁言该用户。 |
| `/unban 用户ID` | 私聊机器人或被管理群组 | 将用户移出本地黑名单，并同步解除其在被管理群组里的封禁或禁言。 |
| 回复用户消息发送 `/ban` | 被管理群组 | 将被回复用户加入本地黑名单，并同步禁言该用户。 |
| 回复用户消息发送 `/unban` | 被管理群组 | 将被回复用户移出本地黑名单，并同步解除其封禁或禁言。 |
| `/spam` | 在群内回复某条消息 | 将被回复消息的发送者加入本地黑名单。 |
| `/check 用户ID` | 私聊机器人或被管理群组 | 查询指定用户的 GKY 封禁记录。 |
| 回复用户消息发送 `/check` | 被管理群组 | 查询被回复用户的 GKY 封禁记录。 |
| `/start check_用户ID` | 私聊机器人 | 管理员二次审核入口，由机器人自动生成链接。 |
| `/add_ad_admin 用户ID` | 私聊机器人 | 将用户加入"热心群友"白名单（白名单成员可在群内直接发起 `/ad` 举报投票）。 |
| `/del_ad_admin 用户ID` | 私聊机器人 | 将用户移出"热心群友"白名单。 |
| `/ban 用户ID` / 回复 `/ban` | 非 `GROUP_ID` 群（bot 为该群管理员） | 标记本群状态"封禁"并封禁踢出，**不修改联网黑名单**（`is_blacklisted`）。 |
| `/spam`（回复） | 非 `GROUP_ID` 群（bot 为该群管理员） | 本群禁言 + 状态"禁言"，**不修改联网黑名单**。 |
| `/unban 用户ID` / 回复 `/unban` | 非 `GROUP_ID` 群（bot 为该群管理员） | 加入本群白名单并解除封禁/禁言，**不修改联网黑名单**。 |

管理员判断通过后，机器人会给出类似下面的复制代码：

```text
GKYbotSave
用户ID
```

请按机器人提示回到目标群发送，用于交给 GKYbot 处理白名单或移出黑名单。

## HTTP 接口

### 查询封禁记录

```http
GET /banlist?tgid=用户ID
```

示例：

```bash
curl "https://你的Worker域名/banlist?tgid=123456789"
```

返回示例：

```json
{
  "success": true,
  "banned": false,
  "tgid": "123456789",
  "message": "此TG帳號并沒有封鎖記錄 / This TG account has no ban record"
}
```

如果存在封禁记录，返回中可能包含：

- `chatId`
- `msgId`
- `reason`
- `info`
- `recordedDate`

## 注意事项

- `TOKEN` 不是 Telegram Bot Token，而是你自己设置的初始化路径密钥。
- `GROUP_ID` 必须是机器人所在的目标群组 ID。
- 初始化入口 `/{TOKEN}` 同时支持 `GET` 和 `POST`。
- Telegram Webhook 只订阅 `message` 类型更新。
- GKY 封禁记录查询依赖外部服务 `https://gkybot.gmeow.cc/banlist`，外部服务不可用时查询会失败。
- `wrangler.toml` 中设置了 `keep_vars = true`，部署时会保留 Cloudflare Dashboard 中已有的环境变量。

## License

本项目使用 MIT License，详见 [LICENSE](./LICENSE)。
