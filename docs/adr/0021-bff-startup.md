# ADR 0021 — 持久 BFF 与独立 works-service 的显式启动装配

状态：已实现；实际非 owner LOGIN 组合验收通过。未据此宣称真实模型、浏览器或 K8s 验收。

## 背景

可用的 v0.1 不能只提供可注入 mock 的 Fastify 工厂。登录凭据、业务内容、会话绑定和待投递命令需要在重建服务后仍存在；服务启动不能顺手迁移数据库，也不能在配置缺失时采用内存存储或超级用户连接。

## 决策

- [生产工厂](../../apps/bff/src/production.ts) 装配真正的 PostgreSQL auth repository、novel repository、runtime dispatcher 与 works-service，只有显式选择 development 模式才允许本地开发登录。OIDC 使用现有 code+PKCE+nonce 校验器。
- [启动配置](../../apps/bff/src/startup-config.ts) 在连接数据库之前校验完整 manifest：业务/auth 使用不同 LOGIN；每个 Cell 唯一租户、明确 works token 与 admin token；凭据的 tenant+Cell 必须与 placement 一致；开发 BFF 与 works 只能绑定 loopback；禁止关闭撤权 outbox。
- `MYRIX_RUNTIME_JWKS_JSON` 是部署方声明的 Cell 公钥清单，不是探测远端安装状态的证据。启动检查不仅比较 kid，还比较当前 P-256 签名私钥所导出公钥的 x/y；不接受含 d 的 JWK。运行时仍由 Cell 真实验签来验证分发是否正确。
- 业务连接对所有 13 张业务表执行非 owner、非特权、实际 LOGIN 与 FORCE RLS 校验；auth 独立连接对三张 auth 表执行非 owner/非特权/实际 LOGIN 校验，不把无 tenant 列的 opaque auth session 错当成 RLS 表。禁止 `SET ROLE` 掩盖特权 session_user。
- 浏览器仓储与 works 执行器使用零系统能力的 store。只有 dispatcher 的单独 store 获得显式命令/outbox 能力；两者复用受限业务连接但不共用 capability 对象。
- 工厂构建不开放端口、不启动轮询。`start()` 先绑定 works，再绑定 BFF，然后开启 dispatcher；中途失败关闭所有已分配资源。`close()` 幂等，停止 dispatcher、关闭 HTTP/SSE，再释放两组数据库连接。
- [CLI](../../apps/bff/src/bin.ts) 处理 SIGINT/SIGTERM，正常清理期限 15 秒；固定的启动失败消息不输出 PostgreSQL URL、OIDC secret、Cell token、签名私钥或上游响应。迁移/种子只由独立 provisioning job 执行。

## 证据与边界

- [配置负例](../../apps/bff/tests/production-config.test.ts)：缺少 manifest/凭据、同一 DB 登录、公开开发监听、关闭 outbox、相同 kid 但错误公钥、私有 JWK、跨租户凭据绑定均拒绝。
- [实际 PostgreSQL 组合验收](../../apps/bff/tests/production.integration.test.ts)：使用业务实际 LOGIN 与临时独立 auth LOGIN，真实登录、创建作品、创建 durable queued command 后销毁并重建整个工厂，旧 cookie 与内容仍可读取；admin 不能读取其他 owner 内容；成员停用后旧 cookie 失效；owner LOGIN 拒绝启动。临时角色完成后释放并移除其 grants。
- 上述重建是同一测试进程中的工厂重建，不是真实 OS 崩溃。工厂测试未启动 dispatcher 去调用真实 Cell；真实 HTTP/DSH/SSE 和模型调用必须另行端到端验收。

## 为什么放行或关闭

所有放行均来自显式配置、当前数据库身份及治理判定。没有完整 placement/凭据/公钥清单就无法证明租户边界，因此在监听之前关闭；实际 LOGIN 有 owner/super/BYPASSRLS 或可达高权限成员关系时，RLS 不能构成边界，因此关闭。组件故障不回退到匿名用户、默认租户或内存成功回执。
