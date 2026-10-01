# ADR-0020：运行入口必须显式连接持久存储与当前业务事实

- 状态：已接受；组合运行验收仍在实施，不能据此声称整条小说生成链已完成。
- 相关：[ADR-0011](./0011-postgres-ownership.md)、[ADR-0013](./0013-bff-authentication.md)、[ADR-0019](./0019-cell-binding-leases.md)。

## 决策及原因

1. 模型网关 CLI 必须同时配置 `DATABASE_URL`（业务 RLS）和 `MYRIX_GATEWAY_DATABASE_URL`（配额账本/凭据解析）。运行入口总是注入 PostgreSQL ledger 与数据库凭据解析器，不接受 `MYRIX_GATEWAY_CREDENTIAL_SOURCE=env`，不回退内存计量。内存端口仅保留给显式注入的单测/假上游验收。
2. 运行期不得自动迁移、登记 Cell 凭据或登记 OIDC subject；这些使用单独的迁移/运维身份。缺表直接拒绝启动，不能以迁移密码兜底。
3. 启动时校验真实 `session_user = current_user`；拒绝超级用户、BYPASSRLS、CREATEDB、CREATEROLE、数据库/受保护表 owner，以及通过角色成员关系可取得上述权限的登录。业务与账本表必须 ENABLE + FORCE RLS；独立 opaque auth schema 不强求租户 RLS，因为认证前尚不知道租户，但依然必须非 owner 并限制授权。
4. 模型网关从服务端 Cell 凭据解析租户，再在 transaction-local RLS 内读取 binding。关联作品必须 active 且与 binding 的租户、owner 同时一致，租户必须 active；成员从当前数据库读取。过期版本、软删除作品、停用成员、冻结租户不能继续开启模型请求；进行中的流仍由网关轮询及时中止。这不是“持锁贯穿整个远程模型请求”的强串行化承诺。
5. 启动报错不打印原始数据库/URL 异常消息，避免密码泄露；缺上游 API key 时正常起服务并对模型请求明确 503，不模拟模型。
6. Gateway migration 使用单个 leased physical connection 持有/释放 session advisory lock，逐迁移事务也在该连接上执行；auth schema 用事务级 advisory lock 串行化 DDL。不能把 pool 上相邻的 query 当成必然同一连接。
7. 同一个 Cell 服务 token 的归属固定为 tenant+Cell。运维 upsert 只能重启用同一归属，不得利用摘要冲突改绑任一字段；条件必须使用完整表限定列名，避免 PostgreSQL 将目标行与 `excluded` 引用判为歧义。运行身份不得登记或枚举凭据。
8. 本地开发 provisioning 也是显式外部 job：[setup-dev](../../apps/bff/scripts/setup-dev.ts) 只允许 loopback:55439 的本仓命名库，迁移、种子与角色登记后，以三个独立的实际 LOGIN 运行同一启动角色校验。私有配置独占创建为 0600，复跑复用签名密钥和 Cell 凭据，不输出秘密；已有文件权限错误或目标库不匹配则拒绝覆盖。它不是生产 bootstrap，也不得成为服务入口的自动回退。

## 代价与替代方案

- 代价：本地开发也必须 provision 分离角色、显式迁移；比“一个超级用户连接串完成一切”步骤多，但错误身份会在启动阶段暴露。
- 不采用运行入口默认 MemoryLedger：重启清零额度，会把测试工具误当生产账本。
- 不只依赖 binding.status：作品被删除、租户被冻结时 binding 未必立即撤销，遗漏父资源当前状态会继续授权。
- `SET ROLE` 本身并不绕过 RLS；RLS 依据 `current_user` 生效。本决策要求真实 LOGIN 是为了验收部署边界，并排除运行代码再切回高权限身份的能力。

## 验证与边界

[业务读取与组合集成测试](../../apps/model-gateway/tests/business-reader.integration.test.ts) 在真正的非 owner、NOSUPERUSER、NOBYPASSRLS LOGIN 上验证当前主体、版本、跨租户/事务上下文、父作品软删除、成员停用、租户冻结及启动角色拒绝。其中新增组合用例再创建独立、随机的实际网关 LOGIN，执行真实数据库凭据登记/解析、跨归属 token 冲突拒绝、撤销失效、缺上游 key 的 503 且预占行数仍为零，以及销毁并重新创建生产服务工厂后同一预占被识别为重放。该用例没有调用真实模型，也不是操作系统进程崩溃/重启验收。

[开发配置测试](../../apps/bff/tests/dev-config.test.ts) 验证目标库限制、不泄密错误、三角色分离、独占创建/权限/密钥复用与异库拒绝；实际本地开发装配也已连续运行两次通过。生产环境与外部凭据不由该测试证明。

[入口配置测试](../../apps/model-gateway/tests/production.test.ts) 验证缺少显式连接与 env 身份映射均 fail-closed，错误不回显连接串值。该测试不代表 Kubernetes、外部 OIDC 或真实模型凭据已经验收。
