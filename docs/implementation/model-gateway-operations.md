# @myrix/model-gateway

OpenAI **Responses** 的 `/v1/responses`（流式 / 非流式），负责 Cell 身份、模型白名单、额度预占与真实用量结算、撤权中止和计量审计。

**本网关只讲 Responses。** 仓库硬性规则禁止 `chat/completions`（AGENTS.md 6），因此：

- 入站只有 `POST /v1/responses`；`/v1/chat/completions` 等旧路径一律 **404**（有回归测试），没有兼容层、隐式转换或失败回退；
- 上游是**完整** `/responses` URL，网关不做路径补全；配置成 chat/completions 会在**启动时**被拒绝；
- 上游 Responses 事件**逐事件原样转发**，从不把 Responses 翻译成 chat 分片。

- [Responses 网关决策](<../adr/0023-responses-gateway.md>)
- [计量决策](<../adr/0015-model-accounting.md>)
- [持久运行入口决策](<../adr/0020-production-assembly.md>)
- [协议与装配说明](<model-gateway.md>)

## 启动

先使用独立迁移身份完成业务、网关两套迁移，并登记 Cell 凭据。服务进程不得使用迁移连接；所有运行连接必须是非 owner、非超级用户、NOBYPASSRLS 的真实 LOGIN，且不能通过角色成员关系取得 owner/高权限身份。

```bash
export DATABASE_URL='postgres://myrix_app:...@127.0.0.1:55439/myrix'
export MYRIX_GATEWAY_DATABASE_URL='postgres://myrix_gateway_login:...@127.0.0.1:55439/myrix'
export MYRIX_GATEWAY_UPSTREAM_URL='https://models.example.com/v1/responses'
export MYRIX_GATEWAY_UPSTREAM_MODEL='example-chat'
export MYRIX_GATEWAY_UPSTREAM_API_KEY='...'
pnpm --filter @myrix/model-gateway start
curl -s http://127.0.0.1:8790/readyz
```

[生产工厂](<../../apps/model-gateway/src/production.ts>) 自动组合真实业务读取、数据库凭据解析与 PostgreSQL 账本。**CLI 没有内存身份/计量降级**；设置 `MYRIX_GATEWAY_CREDENTIAL_SOURCE=env` 会拒绝启动。缺上游 URL/model 会拒绝启动；缺 API key 可启动但模型请求明确返回 503 `model_not_configured`，不预占额度、不调用上游。

## 调用与凭据

浏览器不应直接调用模型网关。Cell 由 [myrix-llm-gateway 插件](<../../plugins/myrix-llm-gateway>) 发送自己的服务凭据及会话/revision；租户、用户、作品和权限从当前数据库解析，不信任模型或浏览器传入的主体归因。

```bash
curl -N http://127.0.0.1:8790/v1/responses \
  -H "authorization: Bearer $CELL_TOKEN" \
  -H "x-myrix-session: $SESSION_ID" \
  -H 'x-myrix-revision: 1' \
  -H 'content-type: application/json' \
  -d '{"model":"example-chat","stream":true,"store":false,"max_output_tokens":1024,
       "input":[{"role":"user","content":[{"type":"input_text","text":"你好"}]}]}'
```

请求体是**无状态**的：`store` 只能是 `false`（缺省也按 false 发送），完整历史由 Cell 以 `input` 提供。
`previous_response_id` / `conversation` / `background`，以及 `user` / `metadata` / `safety_identifier` / `prompt_cache_key`
这类可能覆盖归因或缓存主体的字段一律 **400**。

凭据登记使用 [createPostgresCredentialAdmin](<../../apps/model-gateway/src/db/credentials.ts>) 和单独的 owner 运维连接，只保存 SHA-256 摘要。相同 token 只能重启用原 tenant+Cell 的绑定，不能通过 upsert 改变归属。运行角色只能调用精确摘要解析函数，不能枚举或登记凭据。撤销的凭据不能开始新请求。

## 主要配置

| 变量 | 必填 / 默认 | 含义 |
| --- | --- | --- |
| `DATABASE_URL` | 必填 | 业务 RLS LOGIN |
| `MYRIX_GATEWAY_DATABASE_URL` | 必填 | 账本 LOGIN，继承受限 `myrix_gateway_app` 授权 |
| `MYRIX_GATEWAY_UPSTREAM_URL` | 必填 | **完整 Responses URL**（路径以 `/responses` 结尾）；HTTPS，只有 loopback 可 HTTP；不接受 chat/completions。示例域名 `models.example.com` 是保留占位，不代表供应商 |
| `MYRIX_GATEWAY_UPSTREAM_MODEL` | 必填 | 显式上游模型 |
| `MYRIX_GATEWAY_UPSTREAM_API_KEY` | 无默认 | 缺失时模型请求 503，不模拟降级 |
| `MYRIX_GATEWAY_MODEL_ALLOWLIST` | 上游模型 | 逗号分隔，必须包含上游模型 |
| `MYRIX_GATEWAY_HOST` / `MYRIX_GATEWAY_PORT` | `127.0.0.1` / `8790` | 监听地址 |
| `MYRIX_GATEWAY_MAX_BODY_BYTES` | `1000000` | HTTP 正文上限 |
| `MYRIX_GATEWAY_MAX_OUTPUT_TOKENS` | `8192` | 输出硬上限，超出 400 |
| `MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS` | `min(8192, 硬上限)` | 请求缺省输出预算；未显式配置时取 `min(8192, MYRIX_GATEWAY_MAX_OUTPUT_TOKENS)`，硬上限调低则跟随、调高不放大 |
| `MYRIX_GATEWAY_UPSTREAM_TIMEOUT_MS` | `120000` | 包括流式响应全程的上游截止时间 |
| `MYRIX_GATEWAY_REVOKE_POLL_MS` | `5000` | 流式期间重新检查当前授权 |
| `MYRIX_GATEWAY_LOG` | 不启用 | `1` 打开 Fastify 日志，不输出正文/凭据 |

输入预算按 UTF-8 字节及结构字段估算，包含 `instructions`、`tools` 与 `input` 项的 JSON 成本；这不是精确 tokenizer，也不构成所有模型上的严格 token 上界。超硬限拒绝，不把估算截小后放行。

缺省输出预算取 `min(8192, MYRIX_GATEWAY_MAX_OUTPUT_TOKENS)`，而不是人为的小数字：旧的 `1024` 默认会被一个典型推理回合的 reasoning 吃光，上游以 `incomplete(reason=length)` 收尾（[ADR-0031](<../adr/0031-output-budget-and-turn-outcomes.md>)）。预占 = 输入估算 + 输出预算，因此默认抬高会同步抬高每请求预占；窗口较紧的部署应显式配小该变量，或让调用方显式传 `max_output_tokens`。

结算只认 Responses 的 `usage.input_tokens` / `usage.output_tokens`，映射到既有账本的 prompt/completion 字段，`total_tokens` 取"上游声明值"与两者之和的较大者。`input_tokens_details.cached_tokens` 与 `output_tokens_details.reasoning_tokens` **只作审计元数据**（已含在 input/output 内，不参与扣减）。真实用量完整入账，允许超过预占；未知断流保留预占。升级必须执行新增的 `0001_honest_settlement` 迁移。

## 验证

```bash
pnpm exec vitest run apps/model-gateway/tests
pnpm --filter @myrix/model-gateway smoke
MYRIX_GATEWAY_TEST_DATABASE_URL=postgres://myrix_migrator:...@127.0.0.1:55439/myrix \
  pnpm exec vitest run apps/model-gateway/tests/pg
```

- [协议/HTTP 测试](<../../apps/model-gateway/tests>) 与 [冒烟脚本](<../../apps/model-gateway/scripts/smoke.ts>) 的上游是明确的 HTTP fixture，不是真实模型验收。冒烟同时断言旧 `chat/completions` 返回 404。
- [上游客户端测试](<../../apps/model-gateway/tests/upstream.test.ts>) 验证拒绝跟随重定向（防止上游密钥被带到别的 origin）、异常文案不回显上游 URL、提前退出时 cancel 上游流。
- [账本集成](<../../apps/model-gateway/tests/pg/ledger.pg.test.ts>) 用 `-c role=` 验证有效 `current_user` 下的 FORCE RLS；这确实能验证隔离，但不能证明登录链路，因为 `session_user` 仍是迁移身份。
- [真实 LOGIN 验收](<../../apps/model-gateway/tests/pg/ledger-login.pg.test.ts>) 在随机独立夹具库、非 owner LOGIN 上验证跨租户隔离、超额结算及内存/数据库语义一致。
- [业务与生产组合验收](<../../apps/model-gateway/tests/business-reader.integration.test.ts>) 使用 `BFF_TEST_DATABASE_URL` / `BFF_TEST_MIGRATION_DATABASE_URL`，验证当前父作品/成员/租户事实、真实凭据解析、缺 key 不预占，以及销毁并重建服务实例后预占仍幂等。
- [迁移连接回归](<../../apps/model-gateway/tests/migration-connection.test.ts>) 用每次租借都返回不同连接身份的确定性 pool seam 验证 lock/DDL/事务/unlock 同连接。这不是另一次真实数据库验收。

真实外部模型、外部 OIDC 与 Kubernetes 全链验收仍需部署环境与显式凭据；本文示例里的域名与模型名
（`models.example.com` / `example-chat`）都只是占位。哪些检查能证明什么、哪些必须显式 opt-in，
统一以[验证方法](../testing/acceptance.md)为准；不要用一次本地运行、旧的成功记录或供应商探测
推断当前版本的上游可用性。
