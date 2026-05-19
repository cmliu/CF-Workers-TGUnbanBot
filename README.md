# CF-Workers-TGUnbanBot

基于 Cloudflare Workers 的 Telegram 群组自助解封机器人。机器人会通过 Telegram Webhook 接收消息，帮助被封禁或被禁言的用户在私聊中完成自助解封流程，同时提供管理员黑名单、封禁记录查询和新入群机器人风控能力。

## 功能

- `/start`、`/unban`：向用户展示自助解封说明。
- 用户发送指定确认文本后，自动检查其群内状态，并尝试解除封禁或禁言。
- 管理员私聊 `/ban 用户ID`：将用户加入本机器人维护的 KV 黑名单。
- 管理员私聊 `/unban 用户ID`：将用户移出 KV 黑名单。
- 管理员在群内回复用户消息发送 `/spam`：将被回复用户加入 KV 黑名单。
- 管理员在群内回复用户消息发送 `/check`：查询被回复用户的 GKY 封禁记录，并返回二次审核操作提示。
- `/banlist?tgid=用户ID`：代理查询并解析 `gkybot.gmeow.cc` 的封禁记录。
- 新机器人进群时，如果不是管理员，自动禁言该机器人。

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
| `KV` | 否 | Cloudflare KV 绑定名。黑名单功能依赖它，绑定名必须是 `KV`。 |

KV 中会使用 `blacklist` 这个 key 保存本地黑名单数组。

## 部署

### 1. 安装依赖工具

本项目没有 npm 依赖，只需要 Wrangler：

```bash
npm install -g wrangler
wrangler login
```

### 2. 创建 KV namespace

如果要使用 `/ban`、`/unban 用户ID`、`/spam` 这些本地黑名单功能，需要创建 KV：

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

如果不绑定 KV，自助解封和 GKY 封禁查询仍可运行，但本地黑名单相关命令会提示未绑定 KV。

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
| `/ban 用户ID` | 私聊机器人 | 将用户加入 KV 黑名单。 |
| `/unban 用户ID` | 私聊机器人 | 将用户移出 KV 黑名单。 |
| `/spam` | 在群内回复某条消息 | 将被回复消息的发送者加入 KV 黑名单。 |
| `/check` | 在群内回复某条消息 | 查询被回复用户的 GKY 封禁记录。 |
| `/start check_用户ID` | 私聊机器人 | 管理员二次审核入口，由机器人自动生成链接。 |

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
