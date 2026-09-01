# LLM API 网关

多模型 LLM API 网关，同时兼容 OpenAI 和 Anthropic 协议，统一管理多个服务商（OpenAI、Anthropic、DashScope 等）。内置中文管理后台，支持 API 密钥管理、虚拟模型映射、配额限流、请求日志和用量统计。

## 功能特性

- **双协议兼容** — 同时支持 OpenAI（Chat Completions + Responses API）和 Anthropic Messages API；三类 chat 接口均支持流式 function calling / tool use（工具调用与完整参数一次性下发，不做参数的逐 token 增量流式）。客户端与上游服务商**协议族一致时原样透传**（请求/响应不经协议改写、保留全部参数），**仅在跨协议族时**才做 OpenAI ↔ Anthropic 协议互转（详见 [协议族与请求路由](#协议族与请求路由)）
- **多服务商适配** — 通过 Provider 适配器模式统一对接 OpenAI、Anthropic、阿里云 DashScope
- **向量嵌入与图片生成** — 兼容 OpenAI Embeddings 和 Images API，透传转发
- **虚拟模型映射** — 自定义模型别名，支持 fallback 链
- **密钥管理** — 四种模式：用户密钥（`usr_sk_`）、应用密钥（`app_sk_`）、管理员密钥（`adm_sk_`）、一对一专用密钥（`ded_sk_`）
- **终端用户识别** — 应用密钥支持 `X-App-User-Id` 请求头，追踪每个终端用户用量
- **功能场景标识** — `X-Feature-Id` 请求头标记请求的功能场景（如聊天、翻译、摘要），按功能维度统计用量
- **用户分组** — 网关用户可归入分组，便于按组筛选请求日志；分组在「用户管理」页面维护
- **配额与限流** — 基于 Redis 的令牌桶限流 + Token 配额管理，多实例共享计数，超限自动禁用；限流分全局 / 应用 / 用户 / 密钥四级：应用 / 用户 / 密钥级未配置时按默认 QPS/RPM（10/60）兜底，**全局限流默认不启用**（在「系统设置」显式保存配置后才对全网关生效）；请求前按客户端声明的输出上限（`max_tokens` / `max_output_tokens` / `max_completion_tokens`）预检日/月 Token 配额；配额周期重置（北京时区日/月切边）后，被禁用目标在下次请求时若用量已回落即自动恢复，无需管理员介入；月配额超限的目标在整月内不自动恢复（可由管理员手动恢复）
- **Token 计费口径统一** — 跨服务商统一拆解 prompt cache（缓存命中 token 单列），配额与用量统计均包含缓存 token，避免长会话大量命中缓存时配额少算
- **Token 估算回退可控** — 上游偶发不返回用量时，默认只按真实用量计费（记 0、不估算）；可在「服务商」页为单个服务商开启按字符数的估算兜底（默认关闭，对英文/代码流量可能偏高），对 OpenAI/Anthropic 兼容接口与一对一透传统一生效
- **多实例水平扩展** — 所有共享状态（限流、配额、归档调度、迁移）基于 Redis，可在 k8s 中无状态横向扩容
- **请求日志** — 全量请求记录，支持按时间、模型、服务商、状态码、网关用户、API 密钥、功能标识、终端用户标识筛选；到达上游的错误请求（401/403/429/5xx）同样完整落库（真实状态码与响应体，token 记 0），网关入口层直接拒绝的请求（未认证 401、限流/配额 429）不记录（详见 [错误处理](#错误处理)）；超过保留期（默认 0 = 含当天）的 agentic loop 会话历史自动归并——覆盖 Chat Completions / Responses / Anthropic Messages 三类 chat 接口（按请求体内容识别 `messages` / `input`，与请求路径无关，dedicated 透传走任意路径同样生效；Embeddings / Images 不参与），仅保留每会话最完整的尾部记录，前驱请求的明细字段（请求/响应体等）清空以节省存储；超过保留窗口上界（默认 30 天）的明细记录不再归并，直接物理删除以控制表增长（归并参数为代码内默认，见 `src/config/schema.ts`）；管理后台「请求日志」列表以彩色箭头标示同一会话内被归并行指向其完整后继记录的关系（仅当源、目同处一页时显示，跨页可在请求详情中跳转至完整记录）
- **日志 AI 小结** — 对单条请求日志的完整请求体调用大模型生成中文小结（一句话意图、任务类型、关键上下文、值得注意的点），按需生成、Redis 缓存 30 天，超长请求自动分片 map-reduce 汇总；总结模板可在系统设置页自定义，未设置时使用系统预制默认模板
- **智能分析 Agent** — 对话式运营数据分析助手：管理员用自然语言提问，Agent 自主调用只读查询工具（用量汇总 / 趋势 / 模型维度 Top / 自定义参数化查询，支持跨表 JOIN 关联）获取网关运营数据，以中文 + Markdown 表格流式回答（适合可视化时输出 Mermaid 图表：饼图 / 流程图 / 时序图）；**仅兼容 OpenAI 类型服务商**（OpenAI、DashScope；Anthropic 暂不支持——其流式响应未解析工具调用，会导致工具循环拿不到 function call），模型需支持工具调用（function calling）；推理模型（o 系列 / gpt-5）可流式输出思考过程；查询工具内置表与列白名单 + 参数绑定，敏感字段（API 密钥、上游 key、请求/响应头、客户端 IP 等）一律拒绝返回，全程只读不写；前端支持多会话管理（左侧历史列表，可新建 / 切换 / 重命名 / 删除，会话数据仅保存在浏览器本地，不上传服务端）
- **用量统计** — 按 API Key、应用、用户、模型、功能标识多维度统计，终端用户用量报表
- **报表分析** — 复用请求日志全部过滤条件（时间、模型、服务商、状态码、分组、网关用户、API 密钥、应用、终端用户、功能标识、请求路径、UA 等），对所选区间绘制统计图表：KPI 卡片（总请求 / 总 Token / 缓存 Token / 错误率 / 平均延迟）、时间趋势折线（请求量 + Token + 缓存 Token 双轴，支持小时 / 天 / 周 / 月粒度，按北京时区分桶）、模型 / 服务商 / 状态码分布（饼图占比 + 柱状图排名）；各实体管理页均提供「报表」按钮一键带入过滤条件，可继续下钻到请求日志明细
- **管理后台** — Next.js 中文面板，支持静态部署

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 11（通过 `corepack enable` 自动启用）
- MySQL >= 8.0
- Redis >= 6（强依赖：限流令牌桶 / 配额缓存 / 归档选主锁 / 迁移锁的共享状态）

### 安装与启动

```bash
# 安装依赖（自动启用 pnpm）
corepack enable
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入数据库密码、JWT Secret（>=16字符）、Redis 地址

# 初始化数据库
pnpm exec drizzle-kit generate
pnpm db:migrate

# 启动 Redis（开发环境，任选其一）
docker run -d -p 6379:6379 --name gw-redis redis:8
#   带密码模拟生产认证：docker run -d -p 6379:6379 redis:8 --requirepass yourpass，并在 .env 设 REDIS_PASSWORD
# 或本机已安装的 redis-server

# 启动服务（Redis 必须先就绪——启动时 ping 不通会直接退出）
node --env-file=.env --import tsx src/index.ts
# 或开发模式
pnpm dev
```

首次启动时，若管理员表为空，会自动创建 `admin` 用户并在控制台打印随机密码。

### 管理员 API 密钥

配置日志分析功能时，网关会**自动创建**一个管理员密钥（`adm_sk_`）作为分析调用的记账锚点，通常无需手动操作。

如需手动创建（例如程序化调用管理 API），可执行：

```bash
pnpm db:seed
# 输出: adm_sk_xxxxxxxx
```

管理后台登录使用 JWT（首次启动自动创建的 `admin` 账户 + 控制台打印的随机密码），不直接使用 `adm_sk_`。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `NODE_ENV` | `development` | 运行环境（`development` / `production` / `test`） |
| `DB_HOST` | `localhost` | 数据库地址 |
| `DB_PORT` | `3306` | 数据库端口 |
| `DB_USER` | `root` | 数据库用户 |
| `DB_PASSWORD` | — | **必填** 数据库密码 |
| `DB_NAME` | `llm_gateway` | 数据库名 |
| `JWT_SECRET` | — | **必填** JWT 签名密钥（>=16 字符） |
| `JWT_EXPIRES_IN` | `86400` | JWT 有效期（秒），默认 24 小时 |
| `JWT_RENEW_THRESHOLD` | `28800` | JWT 滑动续期阈值（秒），剩余寿命低于此值时管理后台请求自动续签；改 `JWT_EXPIRES_IN` 时需同步调整（默认约为其 1/3） |
| `REDIS_URL` | `redis://localhost:6379` | **必填** Redis 地址（TLS 用 `rediss://` scheme） |
| `REDIS_PASSWORD` | — | Redis 密码（生产通常必填） |
| `REDIS_USERNAME` | — | Redis 6+ ACL 用户名（留空走经典 AUTH） |
| `REDIS_KEY_PREFIX` | `llmgw:` | Redis key 前缀（多套网关共享同一 Redis 时隔离） |
| `REDIS_MAX_RETRIES` | `1` | 断连时命令排队重试次数。设小值让 Redis 不可达时快速 reject（配合命令超时实现 fail-open），而非长时间排队阻塞请求 |
| `REDIS_COMMAND_TIMEOUT_MS` | `1000` | 已发出命令的超时（ms）。`REDIS_MAX_RETRIES` 只管断连排队、不管慢响应——不配则 Redis 卡顿会拖垮限流、使 fail-open 失效 |
| `REDIS_CONNECT_TIMEOUT_MS` | `2000` | Redis 连接建立超时（ms） |
| `LOG_LEVEL` | `info` | 日志级别（`trace` / `debug` / `info` / `warn` / `error` / `fatal`） |

## API 接口

### 认证方式

所有 API 请求通过以下两种方式鉴权（任选其一）：

- `Authorization: Bearer <api_key>`
- `x-api-key: <api_key>`（兼容 Vercel AI SDK 的 Anthropic provider）

### 支持的协议

#### 协议族与请求路由

三类 chat 接口按**客户端协议族**与所命中模型的**上游服务商协议族**是否一致，分两种处理路径：

| 客户端接口（协议族） | 上游服务商 | 处理路径 |
|---|---|---|
| Chat Completions / Responses（OpenAI） | OpenAI 兼容（OpenAI、DashScope） | 原样透传 |
| Anthropic Messages（Anthropic） | Anthropic | 原样透传 |
| Chat Completions / Responses（OpenAI） | Anthropic | 协议互转 |
| Anthropic Messages（Anthropic） | OpenAI 兼容 | 协议互转 |

- **原样透传**（同族，默认且最常见）：请求体除虚拟模型名替换为上游真实模型名外原样转发，上游响应（含流式 SSE）原样返回。客户端可使用的全部参数都保留——如 Chat Completions 的 `n`/`seed`/`logprobs`/`response_format`/`tool_choice`、Responses 的 `previous_response_id`/`store`/`include`、Anthropic 的 content block 级 `cache_control`/`top_k`。请求仍完整经过认证、限流、配额、日志中间件。
- **协议互转**（跨族）：网关在 OpenAI 与 Anthropic 协议间互转请求与响应（例如用 Claude 模型服务 OpenAI 协议的客户端，或用 GPT 服务 Anthropic 协议的客户端）。互转经由统一的内部表示，会损失少量对方协议不存在的字段。**工具调用的多轮对话完整支持跨族**：OpenAI Chat Completions 的 assistant 顶层 `tool_calls` 与 `{role:"tool", tool_call_id}` 结果消息、Responses 的 `function_call`/`function_call_output` item，都会正确归一化为对方协议的 `tool_use`/`tool_result` 结构，跨协议的多轮 agent 历史不丢失。**图片（vision）输入也完整支持跨族**：OpenAI 的 `image_url`/`input_image`（http URL 或 `data:` base64）与 Anthropic 的 `image`（`source` base64/url）互转归一化，URL 图片不在网关侧下载（直接透传给上游）。

> 边界：Responses 接口要求上游支持 OpenAI Responses 端点；若上游服务商仅提供 Chat Completions（部分兼容服务商），Responses 客户端请求会从上游收到 404。

#### 1. OpenAI Chat Completions（旧版）

```
POST /openai/v1/chat/completions
```

```bash
curl https://your-gateway/openai/v1/chat/completions \
  -H "Authorization: Bearer app_sk_xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 100
  }'
```

支持 `stream: true`、`tools`（function calling）等标准参数；`stream` 与 `tools` 可组合使用，流式下的工具调用以完整 `tool_calls`（含参数）一次性下发。

#### 2. OpenAI Responses API（新版）

```
POST /openai/v1/responses
```

```bash
curl https://your-gateway/openai/v1/responses \
  -H "Authorization: Bearer app_sk_xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "input": "你好",
    "max_output_tokens": 100
  }'
```

`input` 支持字符串或数组格式：

```json
{
  "model": "gpt-4",
  "input": [
    {"role": "system", "content": "你是一个助手"},
    {"role": "user", "content": "你好"},
    {"type": "function_call", "call_id": "call_123", "name": "get_weather", "arguments": "{\"city\":\"北京\"}"},
    {"type": "function_call_output", "call_id": "call_123", "output": "晴天，25°C"}
  ],
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "查询天气",
      "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}}
      }
    }
  ]
}
```

支持 `stream: true`，流式事件遵循 OpenAI Responses 规范。文本内容的完整序列：`response.created` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta`（逐 token）→ `response.output_text.done` → `response.content_part.done` → `response.output_item.done` → `response.completed`（终态）。带 `tools` 时，每个 function call 同样合成 `response.output_item.added`（`status: in_progress`）→ `response.output_item.done`（`status: completed`，完整 `arguments` 一次性到达）事件链。`response.completed` 携带按 `output_index` 排序的完整 `output`（message 与 function_call item 共存）与 `usage`，兼容 OpenAI 官方 SDK / Vercel AI SDK / Agents SDK。

#### 3. Anthropic Messages API

```
POST /anthropic/v1/messages
```

```bash
curl https://your-gateway/anthropic/v1/messages \
  -H "Authorization: Bearer app_sk_xxxx" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

支持 `stream: true`、`tools`、`system` 等标准参数；流式 `tool_use` 同样支持——工具调用以完整的 `content_block_start`（tool_use）→ `content_block_delta`（`input_json_delta`，完整 JSON 一次性到达）→ `content_block_stop` 生命周期下发，`message_delta` 的 `stop_reason` 为 `tool_use`。

#### 4. OpenAI Embeddings（向量嵌入）

```
POST /openai/v1/embeddings
```

```bash
curl https://your-gateway/openai/v1/embeddings \
  -H "Authorization: Bearer app_sk_xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "你好世界"
  }'
```

`input` 支持字符串或字符串数组（批量嵌入）。支持 `encoding_format`、`dimensions` 等标准参数。仅 OpenAI 兼容服务商（OpenAI、DashScope）支持此接口。

#### 5. OpenAI Images（图片生成）

```
POST /openai/v1/images/generations
```

```bash
curl https://your-gateway/openai/v1/images/generations \
  -H "Authorization: Bearer app_sk_xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dall-e-3",
    "prompt": "一只可爱的猫咪",
    "n": 1,
    "size": "1024x1024"
  }'
```

支持 `quality`、`style`、`response_format` 等标准参数。仅 OpenAI 兼容服务商支持此接口。

#### 6. OpenAI Models（模型列表）

```
GET /openai/v1/models
```

```bash
curl https://your-gateway/openai/v1/models \
  -H "Authorization: Bearer app_sk_xxxx"
```

返回网关中已激活的虚拟模型列表，格式兼容 OpenAI 标准。纯本地查询，不调用上游服务商。

### 终端用户识别

使用**应用密钥**（`app_sk_`）时，通过 `X-App-User-Id` 请求头标识终端用户，用于用量统计：

```bash
curl https://your-gateway/openai/v1/chat/completions \
  -H "Authorization: Bearer app_sk_xxxx" \
  -H "X-App-User-Id: user_12345" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "你好"}]}'
```

网关会自动在 `app_users` 表中创建/关联用户记录，并在管理后台的「用户用量」页面展示各终端用户的 Token 消耗；可在该页面为终端用户添加备注名以便辨认（显示在用户标识旁）。

### 功能场景标识

所有密钥模式均可通过 `X-Feature-Id` 请求头标记请求的功能场景，用于按功能维度统计和筛选：

```bash
curl https://your-gateway/openai/v1/chat/completions \
  -H "Authorization: Bearer app_sk_xxxx" \
  -H "X-App-User-Id: user_12345" \
  -H "X-Feature-Id: chat" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "你好"}]}'
```

功能标识为自定义字符串（如 `chat`、`translation`、`summarization`），网关不做验证，直接透传存储。可在管理后台的「功能用量」页面查看各功能标识的 Token 消耗汇总（可为功能标识添加备注名以便辨认），也可在「请求日志」页面按功能标识筛选。两个标识（用户标识与功能标识）独立可选，可同时传递、只传一个或都不传。

### 请求 ID

客户端可通过 `X-Request-ID` 请求头传入自定义请求 ID 用于跨系统链路追踪，网关在响应头中回显该值；未传则自动生成 UUID。请求日志按请求 ID 唯一存储——同一 `X-Request-ID` 重发（重试、连接级缓存、上游网关聚合等）会以最新请求内容覆盖此前的记录并保留首次时间，故日志中不会出现重复 ID。

### 错误处理

- **非流式**：上游错误按对应协议（OpenAI / Anthropic）的标准错误格式返回真实状态码（上游 5xx 映射为 502，其余原样透传）。
- **流式**（`stream: true`）若上游在响应头阶段即返回非 2xx（如模型不支持所传参数、端点不存在、限流、服务端错误），网关**不开 SSE 流**，直接返回 HTTP 错误（真实状态码 + JSON 错误体）——包括部分服务商用 SSE content-type 包装错误响应的场景也已兼容；仅当流建立后中途异常，才在已建立的 SSE 流中下发错误事件（而非静默空流）。客户端应处理这两种错误形态，而非将无内容输出误判为模型返回空。

**错误请求也会落日志**：只要请求到达了上游（成功或失败），都会完整记录到「请求日志」——包括非流式与流式的上游 401/403/429/5xx（chat 三接口、Embeddings、Images 各链路），记录真实状态码与上游响应体，token 记 0 并计入错误统计，便于排查上游密钥失效、限流等问题。上游错误同时会输出到网关控制台日志（429 与 5xx 为 error 级、其余 4xx 为 warn 级，带请求 ID / 服务商 / 模型 / 上游响应体前 500 字），无需打开后台即可在运维日志中发现上游限流与故障。反之，**网关自身在入口层拒绝的请求不落日志**（未通过认证的 401、限流 429、配额预检 429——这类请求未到达上游、无法归属用量）。

> 排查提示：日志里找不到某条 401 时，先看响应体 `error.message`——若是网关固定文案（如 `Invalid API key`、`API key is not active`、`Bound provider is disabled`），说明请求在网关鉴权层就被拒了（按上述口径不落日志）；若是上游风格文案，则该请求应已落日志，可按时间/密钥筛选或检查后端 `Failed to log request` 报错。

## 管理后台

### 访问方式

- **开发模式**：`pnpm --filter llm-gateway-dashboard dev`，访问 http://localhost:3001
- **生产模式**：构建后由网关在 `/dashboard` 路径提供服务

```bash
pnpm --filter llm-gateway-dashboard build
# 启动网关后访问 http://your-gateway:3000/dashboard
```

### 功能页面

| 页面 | 说明 |
|------|------|
| 概览 | 系统总览：Token 消耗趋势图、配额状态卡片（按用量降序排列并带序号） |
| 服务商 | 管理 LLM 服务商（API 地址、密钥、协议类型、Token 估算回退开关）；支持按名称、接口地址或类型搜索；每行可一键跳转到该服务商的报表或请求日志 |
| 用户管理 | 管理网关用户并维护用户分组（对话框形式）；支持按用户名或标识搜索；每行可一键跳转到该用户的报表或请求日志 |
| API 密钥 | 创建/吊销密钥，支持用户、应用、管理员、一对一专用四种模式；支持按名称或密钥前缀搜索；每行可一键跳转到该密钥的报表或请求日志 |
| 虚拟模型 | 配置模型别名和 fallback 链；支持按模型 ID、名称、实际模型或服务商搜索；每行可一键跳转到该模型的报表或请求日志 |
| 应用管理 | 创建应用，为应用分配密钥；支持按名称或描述搜索；每行可一键跳转到该应用的报表或请求日志 |
| 用户用量 | 按终端用户维度统计 Token 消耗（需配合 `X-App-User-Id` 使用）；可为每个终端用户添加备注名（显示在用户标识旁），支持按用户标识或备注模糊搜索；每行可一键跳转到该终端用户的报表或请求日志 |
| 功能用量 | 按功能标识维度统计 Token 消耗（需配合 `X-Feature-Id` 使用）；可为每个功能标识添加备注名（显示在功能标识旁），支持按功能标识或备注模糊搜索；每行可一键跳转到该功能标识的报表或请求日志 |
| 请求日志 | 查看请求记录，支持按时间、模型、服务商、状态码、分组、网关用户、API 密钥、功能标识、终端用户标识筛选（选分组或网关用户后，API 密钥下拉自动收窄到该用户/分组的密钥），并支持按请求路径与 UA 模糊匹配；列表展示请求路径与 UA，详情含请求/响应头与响应内容（流式请求展示合并后的完整文本与 token 用量）并可一键生成 AI 小结；同会话归并关系以彩色箭头可视化 |
| 报表分析 | 复用请求日志全部过滤条件（时间、模型、服务商、状态码、分组、网关用户、API 密钥、应用、终端用户、功能标识、请求路径、UA 等），对所选区间绘制统计图表：KPI 卡片（总请求 / 总 Token / 缓存 Token / 错误率 / 平均延迟）、时间趋势折线（请求量 + Token + 缓存 Token 双轴，支持小时 / 天 / 周 / 月粒度，按北京时区分桶）、模型 / 服务商 / 状态码分布（饼图占比 + 柱状图排名）；底部可一键下钻到对应过滤条件的请求日志明细；各实体管理页（用户 / 应用 / 密钥 / 模型 / 服务商 / 用户用量 / 功能用量）均有「报表」按钮一键带入过滤条件 |
| 智能分析 | 对话式运营数据助手：自然语言提问，Agent 自主调用只读查询工具取数并以中文 + Markdown 表格流式回答（支持跨表 JOIN 关联，适合可视化时输出 Mermaid 图表：饼图 / 流程图 / 时序图）；推理模型可显示思考过程；查询内置表/列白名单与敏感字段拒绝，仅读不写；支持多会话（左侧历史列表，可新建 / 切换 / 重命名 / 删除，每项显示最后对话时间，数据仅存浏览器本地）；使用前需在「系统设置」配置支持工具调用的模型（仅 OpenAI 类型服务商，如 OpenAI / DashScope；Anthropic 暂不支持） |
| 系统设置 | 配置全局限流（QPS/RPM、日/月 Token 限额；显式启用——未保存配置时不对全网关限流，仅应用/用户/密钥级默认限流兜底）、日志保留期（详情/列表天数）、日志分析模型（服务商 + 模型名，保存时自动创建记账密钥）、日志总结模板（可自定义，未设置用预制默认）、智能分析 Agent（仅可选 OpenAI 类型服务商 + 支持工具调用的模型、Agent 系统提示词、思考过程流式开关，保存时自动创建记账密钥）、查看系统信息、修改管理员密码 |
| 管理账户 | 管理后台管理员账号（创建、删除、改角色、重置密码）；仅超级管理员可见 |

### 登录

使用首次启动时控制台打印的超级管理员密码登录；后续管理员由超级管理员在「管理账户」页面创建。

### 管理员角色

后台管理员分两种角色：

- **超级管理员**（`super_admin`）— 首次启动自动创建的 `admin` 用户即此角色，拥有全部权限，可管理其他管理员账号。
- **管理员**（`admin`）— 由超级管理员创建的子管理员，可使用除「管理账户」外的所有功能页面（用户、应用、密钥、模型、服务商、日志、用量、配额、限流、系统设置等）；「管理账户」页面与导航入口仅超级管理员可见，子管理员直访返回 403。

## 一对一代理（Dedicated Proxy）

一对一专用密钥（`ded_sk_`）绑定单个上游服务商，网关做**纯透传转发**：替换域名与 API 密钥，路径、请求体、查询参数原样保留；请求头保留客户端原始格式（含字段名大小写）转发，仅替换凭证值并剥离代理链特征头（详见下文「请求头处理」）。不做协议转换。

### 使用场景

- 对接不支持标准 OpenAI/Anthropic 协议的服务商
- 需要保持客户端原始请求格式不变
- 使用第三方 SDK（如 Vercel AI SDK）直连上游

### 使用方式

1. 在管理后台创建服务商，记录其 API 地址和密钥
2. 创建 API 密钥时选择「一对一」模式（`ded_sk_`），绑定该服务商
3. 客户端将网关地址作为 base URL，请求路径与上游完全一致

```bash
# 示例：智谱 CodingPlan 的 Anthropic 兼容接口
# 上游地址：https://open.bigmodel.cn/api/anthropic/v1/messages
# 客户端配置 base URL 为 http://your-gateway:3000/api/anthropic
# SDK 自动请求 /v1/messages，网关透传到上游

curl http://your-gateway:3000/api/anthropic/v1/messages \
  -H "x-api-key: ded_sk_xxxx" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":100,"messages":[{"role":"user","content":"你好"}]}'
```

一对一密钥支持**任意路径**，网关不做路径映射，直接拼接 `base_url + 请求路径` 转发到上游。

### 请求头处理

dedicated 透传转发时保留客户端请求头的原始格式（含字段名大小写），仅做以下最小处理：

- **凭证换值不改名** — 客户端鉴权头（`Authorization` 或 `x-api-key`）保留原字段名与大小写，值替换为该密钥绑定的上游真实 key（`Authorization` 走 `Bearer …`、`x-api-key` 走裸 key）。
- **剥离代理链特征头** — 网关前方反向代理注入的 `X-Forwarded-*`、`CF-*`、`True-Client-IP`、`Via` 等“转发指纹”会被剥除——直连客户端从不发这些头，保留它们会让上游风控把请求识别为“经转发”而触发限制（这是 dedicated 代理相比直连更容易触发上游风控的常见根因）；hop-by-hop 头（`Connection`、`Keep-Alive` 等）与 `Host` 同样剥除。
- **协议头不自动补** — `anthropic-version` 等协议版本头不补全，完全以客户端为准。

同协议族透传（OpenAI→OpenAI、Anthropic→Anthropic 的兼容接口）的请求头按相同规则处理。

### Token 记账

dedicated 透传同样会记录每次请求的 token 用量（用于配额扣减与用量统计），优先采用上游返回的真实 `usage`。**上游未返回 usage 时默认记 0、不再估算**；若需对这种情况兜底，可在管理后台「服务商」编辑页为该服务商勾选「启用 Token 估算回退」——开启后仅对**生成类接口**（Chat Completions、Messages、Responses）按请求/响应体字符数粗估。此开关默认关闭，且对 OpenAI/Anthropic 兼容接口与一对一透传三条链路统一生效（即上文各类 chat 接口的用量统计也受同一开关控制）。**非生成类接口**（`count_tokens`、Images、Embeddings、Models 等）无论开关如何都不参与估算，只取上游真实值、无则记 0。

非生成类不估算是刻意设计：`count_tokens`（Anthropic 的预估工具、本身不计费）、图片生成（按张计费、无 token 概念）、向量嵌入（无 completion）等接口若走估算，会把请求体/响应体（如图片 base64）误算成巨额 token，造成虚假计费与配额虚增。客户端收到的响应始终为上游原样透传，记账口径不影响客户端可见数据。

### 请求日志

一对一密钥的请求与兼容接口一样会完整记录到请求日志：请求/响应内容、token 用量、状态码、延迟均落库，可在「请求日志」页面按状态码、服务商、密钥等筛选。流式请求从 SSE 事件中提取用量；当客户端请求 `stream: true` 但上游返回非流式错误（如 429 限流、5xx）时，该错误的状态码与响应体同样会被记录，便于排查上游限流与异常。

## 模型路由

请求中的 `model` 字段按以下优先级解析：

1. **虚拟模型表** — 查询 `virtual_models` 表匹配 `modelId`，获取实际服务商和模型名
2. **前缀兜底** — 未匹配到虚拟模型时按前缀分配：
   - `gpt-`、`o1-`、`o3-`、`text-embedding-`、`dall-e-` → OpenAI
   - `claude-` → Anthropic
   - `qwen-` → DashScope

## 管理 API

管理接口使用管理员密钥（`adm_sk_`）或 JWT 鉴权：

```bash
# 创建应用密钥
curl -X POST https://your-gateway/admin/api-keys \
  -H "Authorization: Bearer adm_sk_xxxx" \
  -H "Content-Type: application/json" \
  -d '{"mode": "app", "name": "my-app", "appId": 1}'

# 查询终端用户用量
curl "https://your-gateway/admin/usage/by-app-user?appId=1" \
  -H "Authorization: Bearer adm_sk_xxxx"
```

## 多实例部署

网关设计为**无状态**水平扩展——所有跨实例共享状态都落 Redis，可在 k8s 中直接增加副本数扩容，无需额外配置。

### Redis 共享状态

| 用途 | 说明 |
|------|------|
| 限流令牌桶 | QPS/RPM 计数跨实例共享，N 副本不会把限流放大 N 倍 |
| 配额缓存 | 乐观递增走 Lua 原子操作，多 pod 看到同一配额增量 |
| 归档选主锁 | 每天归档全局只跑一次（按 UTC 日期选主，避免 N pod 重复扫表） |
| 迁移锁 | 滚动更新含新迁移时，多 pod 串行化 DDL，杜绝并发建表 |

Redis 是**强依赖**：启动时 ping 不通即 `exit(1)`；运行时短暂抖动则 **fail-open** 降级——限流放行、配额预检回退直查数据库（准确）、归档/迁移跳过本次下周期重试。因此生产 Redis 须保证高可用（阿里云 Tair / ElastiCache / Sentinel / Cluster）。

### 容器部署注意

- **MySQL 连接数**：`max_connections ≥ 10 × 副本数 + 余量`（每副本连接池上限 10）；ioredis 每副本默认 1 连接，不构成压力
- **优雅下线**：流式上游超时兜底 1 小时，k8s 需配 `terminationGracePeriodSeconds: 3700`，否则长流式生成会在默认 30s 被强杀
- **时区**：容器 `TZ` 可任意设置——归档锁 key 与 runHour 强制走 UTC，数据库连接 session 也钉死 UTC，时间逻辑不依赖进程时区（`TZ` 仅影响日志时间戳）
- **自动迁移**：启动时自动应用迁移（分布式锁串行化），生产无需手动 `pnpm db:migrate`

### 本地验证（无需 k8s）

```bash
# 共享同一 MySQL + 同一 Redis，起两个实例
PORT=3001 node --env-file=.env --import tsx src/index.ts &
PORT=3002 node --env-file=.env --import tsx src/index.ts &

# 同一 api_key 轮询打 :3001/:3002，合计超 QPS 后开始 429——验证限流跨实例共享
# fail-open：docker stop gw-redis 后限流仍放行（非 429）、配额预检回退 DB、归档 tick 跳过
```

## 开发

```bash
# 后端开发（热重载）
pnpm dev

# 前端开发
pnpm --filter llm-gateway-dashboard dev

# 运行测试
pnpm test

# 单个测试文件
pnpm exec vitest run tests/openai-provider.test.ts

# 构建生产版本
pnpm build

# 数据库迁移
pnpm exec drizzle-kit generate   # 生成迁移
pnpm db:migrate                  # 执行迁移
pnpm db:seed                     # 填充初始数据

# 开发本地容器构建与推送（示例）
docker build --provenance=false -t swr.cn-south-1.myhuaweicloud.com/anjoyfood/my-llm .
docker push swr.cn-south-1.myhuaweicloud.com/anjoyfood/my-llm
```

## 技术栈

- **后端**：Hono + Drizzle ORM + MySQL + Pino
- **前端**：Next.js 16 + React 19 + shadcn/ui + Tailwind CSS + Recharts + Mermaid
