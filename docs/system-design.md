# SamAPI 系统设计

## 目标

SamAPI 面向本地或内网客户端提供统一的模型调用入口。管理员在控制台维护供应商站点、调用密钥、Header 模版和路由规则；客户端只需要访问本机或局域网代理地址，由 SamAPI 决定实际调用哪个上游模型。

## 功能边界

第一阶段实现：

- 站点管理：维护供应商名称，支持一个站点配置多个地址；模型维护后续独立设计。
- 密钥管理：生成唯一密钥，下游客户端通过密钥访问本地代理。
- API Key 管理：按供应商维护上游 API Key 分组，每个分组可包含多个 Key，并记录该 Key 可用模型。
- Header 管理：用 key-value 表单维护上游 Header，支持 `${ENV_NAME}` 读取环境变量。
- 路由管理：实现切换型路由和分组型路由。切换型绑定供应商和模型；分组型由管理员维护组内模型成员，可用匹配规则自动补全多个供应商的相似模型，并支持稳定优先、顺序执行、随机调用策略。
- 本地代理：以 `/proxy` 为网关根路径，兼容 Claude Messages、OpenAI Chat/Responses 和 Gemini GenerateContent 路径；从请求体或 Gemini 路径中的模型名读取路由名，并转发到路由绑定的上游 endpoint。
- 日志管理：默认记录所有模型代理请求，折叠状态展示模型、供应商、UA、成功/失败状态，展开状态展示请求详情。
- 设置管理：维护系统级配置，当前支持调整请求日志最多保留条数，默认 100 条。
- 数据持久化：配置默认保存到 `data/samapi.json`，请求日志保存到 `data/request-logs.jsonl`，可通过 `SAMAPI_DATA_DIR` 指定目录。

后续增强：

- 调用统计：延迟、错误率、可用性、最近失败原因。
- 短时间熔断：不可用供应商可被暂时跳过，减少连续失败请求。

## 数据模型

### Site

站点代表一个供应商，例如 OpenAI、Anthropic、本地 Ollama 或兼容 OpenAI API 的中转服务。

字段：

- `id`：唯一 ID。
- `name`：供应商名称。
- `siteType`：网站类型，当前支持 `newapi` 和 `unknown`。
- `addresses`：供应商地址列表。
- `createdAt` / `updatedAt`：审计时间。

### SiteAddress

字段：

- `id`：唯一 ID。
- `label`：地址名称，例如官方、内网、代理。
- `baseUrl`：上游基础地址，例如 `https://api.openai.com/v1`。
- `enabled`：是否启用。
- `models`：预留的模型列表字段，当前站点管理不维护，默认可为空。

### ApiKeyRecord

字段：

- `id`：唯一 ID。
- `name`：密钥名称。
- `prefix`：密钥前缀，用于 UI 展示。
- `keyHash`：密钥哈希，用于下游请求校验。
- `plainTextKey`：完整密钥，保存在本地数据库中，用于管理台列表复制。
- `enabled`：是否启用。
- `lastUsedAt`：最近调用时间。

### ProviderApiKeyGroup

字段：

- `id`：唯一 ID。
- `siteId`：关联供应商。
- `groupName`：分组名称，由关联站点名称自动生成，不在 UI 中手动填写。
- `apiKeys`：同一供应商下的一组上游 API Key。
- `createdAt` / `updatedAt`：审计时间。

### ProviderApiKeyEntry

字段：

- `id`：唯一 ID。
- `label`：Key 名称。
- `prefix`：Key 前缀，用于列表展示。
- `secret`：真实上游 API Key，保存在本地数据库中；列表只展示前缀，编辑弹窗会回显完整值。
- `enabled`：是否启用。
- `models`：通过供应商模型发现接口得到的模型列表；NewApi 站点使用 `/api/pricing` 并按 Key 名称匹配 `enable_groups`。
- `lastCheckedAt`：最近一次模型发现时间。

### HeaderTemplate

字段：

- `id`：唯一 ID。
- `name`：模版名称。
- `headersText`：Header 持久化文本，每行一个 `Key: Value`；管理台以 key-value 行编辑。

### AppSettings

字段：

- `maxRequestLogs`：请求日志最多保留条数，默认 100，超过后自动丢弃最旧记录。

示例：

```text
Authorization: Bearer ${OPENAI_API_KEY}
Content-Type: application/json
```

### SwitchRoute

字段：

- `id`：唯一 ID。
- `name`：路由名称，也作为本地代理路径的一部分。
- `type`：固定为 `switch`。
- `siteId`：供应商 ID。
- `addressId`：可选兼容字段；新增路由不再绑定具体地址。
- `model`：目标模型。
- `endpoint`：`messages`、`chat/completions` 或 `responses`。
- `headerTemplateId`：可选 Header 模版 ID。
- `enabled`：是否启用。

代理请求时，切换型路由只绑定供应商站点。系统会按该站点的启用地址顺序请求上游：先请求第一个地址，失败后自动切换到下一个地址，直到请求成功或没有可用地址。

### GroupRoute

字段：

- `id`：唯一 ID。
- `name`：路由名称，也作为下游请求里的模型名。
- `type`：固定为 `group`。
- `matchRule`：自动匹配关键词。同步模型后会使用与智能勾选一致的关键词匹配：先尝试前缀命中，再按模型名 token 匹配，例如 `deepseek v4` 可匹配 `deepseek-v4-pro` 和 `deepseek-v4-flash`。
- `members`：组内模型成员，每个成员指向一个供应商 API Key 下的一个真实上游模型。
- `strategy`：调用策略，支持 `stable-first`、`sequential`、`random`。
- `endpoint`：`messages`、`chat/completions` 或 `responses`。
- `headerTemplateId`：可选 Header 模版 ID。
- `enabled`：是否启用。

代理请求时，分组型路由会从 `members` 中生成候选上游。下游请求里的 `model` 是路由名，例如 `gpt-5.5`；实际转发时，系统会按策略选择组内真实模型，例如不同供应商下的 `gpt-5.5`、`gpt-5.5-pro` 或兼容命名模型。同步模型后，系统会根据 `matchRule` 自动把新发现且匹配的模型补进该分组。

### RequestLog

字段：

- `id`：唯一 ID。
- `createdAt`：请求时间。
- `routeName` / `routeId`：命中的路由。
- `providerName` / `providerId`：供应商。
- `addressLabel`：供应商地址名称。
- `model`：最终请求模型。
- `endpoint`：最终请求 endpoint。
- `userAgent`：客户端 UA。
- `clientIp`：客户端 IP。
- `status`：`success` 或 `failed`。
- `statusCode`：上游或本地代理状态码。
- `durationMs`：耗时。
- `requestHeaders`：请求 Header，敏感字段会被遮蔽。
- `requestBody`：请求体。
- `upstreamUrl`：上游请求地址。
- `responsePreview`：响应预览。
- `errorMessage`：失败原因。
- `downstream`：下游请求摘要，包含模型名、endpoint、UA、路径和方法。
- `routeTarget`：项目内路由匹配结果，包含路由名、目标模型、目标 endpoint、供应商和上游 UA。
- `upstreamAttempts`：上游请求尝试列表，记录每次请求的地址、URL、模型、endpoint、状态码、耗时、响应预览和错误。
- `summary`：链路总结，格式为“下游模型(endpoint/UA) -> 路由目标模型(endpoint/UA) -> 状态”。

日志默认最多保留最近 100 条，避免文件数据库无限增长。

## API 设计

管理 API：

- `GET /api/snapshot`：一次性获取控制台所需数据。
- `GET /api/sites` / `POST /api/sites` / `PATCH /api/sites/:id` / `DELETE /api/sites/:id`
- `GET /api/keys` / `POST /api/keys` / `PATCH /api/keys/:id` / `DELETE /api/keys/:id`
- `GET /api/provider-key-groups` / `POST /api/provider-key-groups` / `DELETE /api/provider-key-groups/:id`
- `POST /api/provider-key-groups/discover-models`
- `GET /api/headers` / `POST /api/headers` / `PATCH /api/headers/:id` / `DELETE /api/headers/:id`
- `GET /api/routes` / `POST /api/routes` / `PATCH /api/routes/:id` / `DELETE /api/routes/:id`
- `GET /api/logs` / `DELETE /api/logs/:id` / `DELETE /api/logs/clear`

代理 API：

- `GET /proxy/models`
- `GET /proxy/v1/models`
- `GET /proxy/v1beta/models`
- `POST /proxy`
- `POST /proxy/v1/messages`
- `POST /proxy/v1/chat/completions`
- `POST /proxy/v1/responses`
- `POST /proxy/v1beta/models/:routeName:generateContent`

代理处理流程：

1. 校验下游 API Key。若未创建任何密钥，允许本地开发调用。
2. 模型列表接口返回启用中的路由名称，供下游作为 `model` 使用；带 `anthropic-version` / `anthropic-beta` 的 Claude 风格请求返回 Anthropic 模型列表格式，其他请求返回 OpenAI 兼容格式。
3. 根据请求体 `model` 查找启用中的路由；Gemini 请求根据路径里的模型名查找路由。
4. 若为切换型路由，读取站点地址、模型、endpoint 和 Header 模版；若为分组型路由，根据组内模型成员按策略生成候选上游。
5. 将请求体里的 `model` 替换为路由绑定的真实上游模型。
6. 将请求体转发到 `${baseUrl}/${endpoint}`。
7. 返回上游响应。

## UI 信息架构

左侧导航：

- 路由管理
- 站点管理
- API Key 管理
- 客户端密钥
- Header 模版
- 日志管理
- 接入

核心操作流：

1. 在站点管理里创建供应商，填入一个或多个地址。
2. 在 Header 模版里维护上游鉴权 Header。
3. 在密钥管理里生成给客户端使用的密钥。
4. 在路由管理里创建切换型或分组型路由；分组型路由填写匹配规则并勾选多个供应商的相似模型。
5. 客户端配置 `base_url = http://localhost:8787/proxy`、`api_key = sk-samapi-...`、`model = 路由名`。

## 分组路由策略

- 稳定优先：优先使用最近一次成功的组内模型成员；没有成功记录时按保存顺序尝试，失败后继续顺序降级。
- 顺序执行：每次都按组内模型成员保存顺序尝试，失败后顺序降级。
- 随机调用：每次请求随机打乱候选顺序。

所有策略共享失败转移逻辑：每次请求最多尝试组内所有启用候选；成功即返回；全部失败后返回聚合错误。
