# 单机认证装配：Keycloak OIDC + 宿主 Nginx

本指南说明认证配置契约。**首次部署以[自部署指南](<self-hosting.md>)为操作入口**，不要将认证 renderer 的独立产物直接混进另一套初始化配置。现场凭据与维护者运行记录不随文档分发。

## 1. 组件与纯配置接口

- [auth-config.ts](<../../deploy/auth/auth-config.ts>)：`deploy/auth/auth-config.ts` 导出纯函数 `createAuthConfig()`，无 I/O、隐式时钟或环境读取。
- [render-auth.mjs](<../../deploy/auth/render-auth.mjs>)：可选独立 renderer，默认拒绝覆盖、symlink 和危险路径；目录0700/文件0600，不打印 secret。
- [compose.auth.yml](<../../deploy/auth/compose.auth.yml>)：Keycloak 覆盖片段，与[基础编排](<../../deploy/vps/compose.yml>)一起使用。
- [init.mjs](<../../deploy/vps/init.mjs>)：标准单机入口，调用工厂并统一生成身份、数据库、认证和业务配置。

工厂必须收到 domain、clientId/clientSecret、ownerId/ownerUsername/ownerPassword、Keycloak 数据库及 bootstrap 管理凭据、固定镜像引用。示例域名使用 `myrix.example.com`；真实秘密通过受限环境/文件提供，不写命令历史。

| 产物 | 用途 |
| --- | --- |
| `nginxSite` | 完整站点或 location snippet；既有 Nginx 使用 snippet 集成 |
| `keycloakPublicEnv` | 非密的 KC 配置，包括公开 hostname、相对路径与健康参数 |
| `keycloakSecretEnv` | IdP 数据库及 bootstrap 管理口令；不可记录日志 |
| `bffOidcEnv` | BFF 的公开 issuer/client 与私有 client secret |
| `realmImportJson` | 含 owner 临时口令及 client secret 的首次导入文件 |
| `keycloakDbInitSql` | 含数据库口令的独立库初始化 SQL，仅授权管理员执行 |
| `ownerSubject` | `{ issuer, subject }`，必须与业务预登记行及 Keycloak sub 一致 |
| `compose` | 认证服务片段，不重新定义业务服务 |
| `bootstrap` | `start` / `importRealm` 均为 `start --optimized --import-realm`；不是两个依次执行的步骤 |

工厂及 renderer 的测试见[认证测试](<../../tests/auth-deploy/>)。测试通过只证明配置契约，不证明你的 VPS 已经可登录。

## 2. Origin 与 issuer：两个不同值

| 概念 | 标准值 |
| --- | --- |
| 浏览器 `origin` | `https://myrix.example.com`，无路径 |
| Keycloak 公共基础 URL | `https://myrix.example.com/auth` |
| `issuer` | `https://myrix.example.com/auth/realms/myrix` |
| BFF callback | `https://myrix.example.com/api/v1/auth/callback` |
| authorization/token/certs | issuer 下的 `protocol/openid-connect/auth` / `token` / `certs` |

必须同时配置：

```text
KC_HTTP_RELATIVE_PATH=/auth
KC_HOSTNAME=https://myrix.example.com/auth
KC_PROXY_HEADERS=xforwarded
KC_HTTP_MANAGEMENT_RELATIVE_PATH=/
```

`KC_HTTP_RELATIVE_PATH` 不会自动拼入裸 `KC_HOSTNAME`。漏掉 `/auth` 会发布错误 issuer，BFF 会拒绝启动；不要关闭校验、改内部 HTTP issuer、关闭 TLS 或用另一份 realm `frontendUrl` 掩盖错误。`webOrigins` 使用无路径的浏览器 origin，不能填 issuer。

## 3. 镜像与启动

Keycloak 与 BFF/Gateway/Cell 使用同一完整 SHA 的 CI 镜像。优化构建在镜像构建阶段完成，运行期**不执行 `kc.sh build`**。build-time 与 runtime 的 `KC_DB`、`KC_HEALTH_ENABLED`、`KC_METRICS_ENABLED` 必须一致，见[镜像测试](<../../tests/containers/keycloak-image.test.mjs>)。

运行命令：`start --optimized --import-realm`。不要单独 `run --rm ... start --import-realm` 等它退出：这是长期服务，不是一次性任务。

- startup import 只创建缺失 realm；已存在则跳过，不覆盖账号、口令或 client secret。
- 改导入 JSON 再重启不等于轮换秘密；使用管理 API/控制台明确变更，保留审计。
- 不以删除 IdP 数据库、清卷或强制 offline import 代替升级/恢复。
- 首次 owner 密码是临时密码，首次登录强制 `UPDATE_PASSWORD`。修改之后 JSON 中的初始值不再代表现行密码。

认证服务依赖 `postgres: service_healthy` 与 `provision: service_completed_successfully`。独立 Keycloak 库/低权 LOGIN 由 provision 显式建立，不用业务迁移角色创建 IdP 库，也不是应用启动时自动迁移。

**顺序**：先 PostgreSQL/Keycloak → 集成宿主 Nginx → 检查公开 HTTPS discovery → 再 BFF/Gateway/Cell。完整命令见[首次启动](<self-hosting.md#13-拉起>)。

## 4. 文件、容器与网络隔离

- Keycloak 为 UID/GID1000、只读 rootfs、drop ALL、no-new-privileges；`/tmp` 和 `/opt/keycloak/data` 为受限 tmpfs。
- realm 只读挂载到 `/opt/keycloak/data/import/realm-myrix.json`，含秘密，必须0600且 UID1000可读。**确认是本次生成的普通文件后**只改该文件属主，不递归开放整个秘密目录。
- 标准 init 输出在 `deploy/vps/auth/realm-myrix.json`；独立 renderer 输出位置由 `--out` 决定。不要混用两者路径或身份。
- 单机 provision/grants 读取的 SQL 与数据库秘密文件另有 UID1000要求，按自部署指南处理。
- Keycloak 只发布 `127.0.0.1:18080 → 8080`；9000管理/健康端口不发布。BFF仅回环8787，数据库、网关、Cell不发布。
- Keycloak 独立库及角色默认为 `keycloak`；口令不进入 BFF/Cell/Gateway。业务运行服务不持有迁移/管理员权限。

## 5. 宿主 Nginx 集成

使用既有 Nginx/TLS，不接管无关站点、证书或 ACME 流程。备份现有配置后，将生成 snippet 合入本域名已有 server；不得直接覆盖整个站点。`nginx -t` 成功后才 reload，随后用有界 readiness 复核。

- `/auth` 与 realm 需要的路径转到回环 Keycloak；`/api/v1/auth/callback` 转到 BFF。
- 公网 `/auth/admin` 与 `/auth/realms/master`（及其子路径）返回404，不为管理方便开放。
- 清洗转发头：固定规范 Host/HTTPS，X-Forwarded-For取真实对端，不透传用户伪造值。
- 回调 query 含一次性授权码，不记录未脱敏查询串；SSE 禁用代理缓冲。
- 保留既有 TLS、ACME、allowlist 与其他站点规则。不为容器访问全局放宽源站防护；精确验证公开 discovery 和 token 交换路径。

## 6. 身份预登记与补员

BFF 使用 Authorization Code + PKCE(S256)、confidential client 与 `openid profile`；关闭 implicit flow、ROPC、service account、自助注册和密码找回。默认无 SMTP，不依赖外部 SSO。

仅在 Keycloak 创建用户还不能登录工作台。需要有权限的部署操作者完成：

1. 创建独立 Keycloak 用户，取得实际 `sub`；不要借用或重置已有 owner。
2. 在正确 active tenant 中新增 `members`（明确 `user_id`、role、status），登记 `myrix_auth.subjects` 的 `(issuer, subject) → (tenant_id, user_id)`，记录审计。
3. 事务内设置租户上下文，保持 FORCE RLS；运行期 BFF 只有读取 subjects 的权限，不可自助补员。
4. IdP 与业务库没有跨系统事务：部分失败时关闭新 IdP 用户并核对状态，不放宽授权、不覆盖既有映射。
5. 用真实浏览器完成 OIDC 登录，核对服务端身份及可见作品边界。工作台 admin 不等于 IdP/服务器管理员，也不绕过作品单属主授权。

初始化器只生成1租户/1 Cell/1 owner；同租户额外成员可显式补员，这不代表多租户切换已实现。同一 `(issuer, subject)` 只能映射到一个租户。

共享公开演示账号必须另有维护者明确授权、独立身份和访客不隔离警告；不能把 bootstrap admin 或私人 owner 的密码公开。自部署者必须使用自己的秘密。

## 7. 现场验收与证据

每个自部署环境分别检查：

1. 公开 discovery 的 issuer 与各端点精确匹配，BFF 能完成 token 交换。
2. 空库首次导入、owner 首次改密、重启后不会重置密码。
3. 正确 sub 预登记；未登记、disabled 或 suspended 状态拒绝登录。
4. Nginx合法，管理路径404、公开认证可达、回调无秘密日志、SSE实时到达。
5. 非 root/read-only、realm属主、仅回环端口与独立数据库权限。
6. 真实模型、写入、重启持久化和全套恢复另行验收，不由登录成功推断。

[本轮验证指南](<../testing/acceptance.md>)记录演示实例本次实际执行范围；它不能替代其他人的部署验收。历史现场交接不作为公开文档依赖。

## 8. 离线回归

```bash
node --test tests/auth-deploy/*.test.mjs
node --test tests/containers/keycloak-image.test.mjs
```

覆盖工厂纯性、issuer/base URL、realm权限、临时密码、路径默认拒绝、文件权限、no-clobber、秘密脱敏、Compose安全字段与镜像构建参数。测试使用假秘密，不读取真实配置、不启动线上服务或申请证书。
