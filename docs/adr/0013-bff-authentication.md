# ADR-0013：BFF 登录身份与浏览器写入保护

状态：实施中。依据平台规划 D4 / D11；替代旧控制面的共享 admin token 作为新小说应用的入口。

## 决策

生产模式仅接受 OIDC Authorization Code + PKCE，验证 state、nonce、issuer 和 ID Token。回调使用配置的固定 HTTPS origin，不信任请求 Host 或转发头拼接 redirect URI。身份来自预先配置的 `(issuer, subject) → (tenantId, userId)`，首次登录不自动加入租户、不按 email 相同合并账号。

浏览器拿到 256 位随机不透明 session cookie；数据库只保存 token 的 SHA-256 摘要、用户绑定、CSRF 凭证和过期时间。Cookie 使用 HttpOnly、SameSite=Lax、生产 Secure；登出删除服务端会话，不能仅清浏览器 Cookie。OIDC state、nonce、PKCE verifier 保存于一次性登录流程记录，回调原子删除后才能消费。

每个认证请求重新读取当前租户/成员状态，不将登录时的角色快照当成长期权限。浏览器传入的租户、用户、归因 headers 均不能改变主体。认证和授权分离：认证确认身份，governance 判定当前动作，业务存储按当前所有者再次约束查询。

所有浏览器写操作要求精确匹配的 Origin，登录后的写操作还要求与服务端会话绑定的 `X-CSRF-Token`。认证端点及业务 API 设置 no-store；令牌、Cookie、OIDC code 不进入日志。

## 开发模式

只有显式选择 development，且配置来源和实际监听地址都为 loopback，才允许使用预设开发身份。它不是生产回退路径；OIDC 失败绝不能转到开发登录。开发模式 UI 明显标识，服务不接受用户任意指定 tenantId 或 userId。

## 存储边界

`myrix_auth` 是 BFF 的凭据 schema；初始查找时租户尚未确定，不能用请求提供的租户做 RLS 上下文。它不存小说内容。只对专用 BFF 数据库角色授予 session/flow 的必要操作与 subject 映射只读权，PUBLIC 无权限；Runtime Cell 和业务服务不获得该凭据存储权限。业务表仍使用 tenant_id + FORCE RLS，不能以该例外豁免业务隔离。

会话最多 24 小时，具体时长由部署指定；过期记录通过清理任务删除。生产 IdP 配置、组织成员预置、密钥和数据库凭据均由操作者提供，不在仓库提交秘密。

## 验收

必须覆盖：无凭据、伪造归因、CSRF/Origin 错误、过期、停用成员、登出后重放、开发模式暴露公网、OIDC state/nonce 与一次性消费负例。使用测试替身验证 HTTP 控制流，不把替身当成真实 IdP 或 Postgres 验收。
