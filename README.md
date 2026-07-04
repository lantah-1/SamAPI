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

## 部署到 Render 免费服务

项目已包含 `render.yaml`，可以直接用 Render Blueprint 部署。

1. 将仓库推送到 GitHub。
2. 在 Render 选择 **New +** → **Blueprint**，连接该仓库。
3. 部署时填写 `SAMAPI_ADMIN_PASSWORD`，请使用强密码。
4. 部署完成后，在 Render 的 Custom Domains 添加你的域名，并按提示配置 DNS。

Render 会自动生成 `SAMAPI_ADMIN_SESSION_SECRET`，并把数据目录挂载到 `/var/data`。如果平台提示免费套餐不支持 Disk，可以先删除 `render.yaml` 中的 `disk` 配置试运行，但重启或重部署后本地数据可能丢失。

关键环境变量：

```bash
SAMAPI_HOST=0.0.0.0
SAMAPI_WEB_DIR=dist
SAMAPI_DATA_DIR=/var/data
SAMAPI_ADMIN_PASSWORD=你的强密码
SAMAPI_ADMIN_SESSION_SECRET=随机长字符串
SAMAPI_ADMIN_COOKIE_SECURE=true
```

本地验证生产构建：

```bash
pnpm build
SAMAPI_ADMIN_PASSWORD=local-test pnpm start
```

## 文档

- [系统设计](./docs/system-design.md)
- [开发计划](./docs/development-plan.md)
