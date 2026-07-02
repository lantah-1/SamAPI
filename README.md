# SamAPI

SamAPI 是一个本地模型路由控制台，用于管理上游模型供应商、下游调用密钥、Header 模版和模型路由。第一阶段实现切换型路由：固定选择一个供应商地址、模型、Header 模版和 endpoint，然后通过本地 `localhost` 代理给不同客户端调用。

## 启动

```bash
pnpm install
pnpm dev
```

默认地址：

- 管理台：`http://127.0.0.1:5173`
- 本地 API：`http://127.0.0.1:8787`
- 数据库：`data/samapi.json`

指定数据目录：

```bash
SAMAPI_DATA_DIR=/path/to/data pnpm dev:api
```

## 客户端调用

```bash
curl http://127.0.0.1:8787/proxy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-samapi-..." \
  -d '{"model":"default-messages","messages":[{"role":"user","content":"hello"}]}'
```

当系统没有创建任何密钥时，代理接口允许本地开发调用；创建密钥后，请使用 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`。

## 文档

- [系统设计](./docs/system-design.md)
- [开发计划](./docs/development-plan.md)
