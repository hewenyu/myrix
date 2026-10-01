# Myrix 单机 VPS 认证装配（Keycloak OIDC + 宿主 Nginx）

本目录只负责**认证层**：Keycloak（OIDC IdP）、它的镜像与 Compose 片段、宿主 Nginx
站点，以及把它接到 Lead 的 `deploy/vps/**` 编排与 BFF 上所需的全部配置。

TLS 终止、证书与公网路由由**宿主上既有的 Nginx** 负责：本仓库不引入其它反代/证书
组件，也不生成其配置，没有端口模式分支，也不保留任何兼容层。它**不定义** `postgres`、
`bff`、`cell`、`gateway`，也不改 `deploy/vps/**`、Dockerfile、`.github`、`apps/**`、
`plugins/**`、`packages/**`、`vendor/**`。

```
deploy/auth/
  auth-config.ts        纯 config 工厂：realm JSON / Nginx 站点 / Keycloak env / Compose 片段
  render-auth.mjs       可选 CLI：把工厂产物落盘到 0700/0600 目录（默认不覆盖，不打印 secret）
  compose.auth.yml      人工可读的 Compose 片段（与工厂输出等价，字段以工厂为准）
  README.md             本文件
tests/auth-deploy/
  auth-config.test.mjs  node:test 纯测试（不写真实 env、不拉镜像、不启动服务）
  render-auth.test.mjs  CLI 回归：no-clobber、危险 basename、symlink、secret 不外泄
```

## 1. 整合接口（Lead 只需要这几件事）

### 1.1 工厂

```ts
import { createAuthConfig } from "./deploy/auth/auth-config.ts";

const auth = createAuthConfig({
  domain: "br.example.test",
  clientId: "myrix-bff",
  clientSecret: env.MYRIX_OIDC_CLIENT_SECRET,
  ownerId: "11111111-1111-4111-8111-111111111111", // 同时是 OIDC sub
  ownerUsername: "owner",
  ownerPassword: env.MYRIX_OWNER_PASSWORD,          // 临时密码，首次登录强制更换
  keycloakDbPassword: env.KEYCLOAK_DB_PASSWORD,     // 独立库密码，只有 Keycloak 知道
  keycloakAdminUsername: "kcadmin",
  keycloakAdminPassword: env.KEYCLOAK_ADMIN_PASSWORD,
  images: {                                          // 必须显式固定，无默认、无 latest
    keycloak: "docker.io/hewenyulucky/myrix:keycloak-sha-<40hex>", // 或 @sha256:<64hex>
    postgres: "postgres:17.6-alpine",
  },
  nginxSiteDomain: "br.example.test", // 省略则用占位符 MYRIX_PUBLIC_DOMAIN
});
```

纯函数：无 I/O、无时钟、无 `process.env`。相同入参永远得到相同输出（有测试）。
地址派生与契约来源：

| 产物 | 值 | 契约来源 |
| --- | --- | --- |
| `origin` | `https://<domain>` | 浏览器站点 origin（**无路径**）：`MYRIX_ORIGIN`、`webOrigins` 与回调都用它 |
| `keycloakBaseUrl` | `https://<domain>/auth` | Keycloak 公网**基础 URL**（含 `KC_HTTP_RELATIVE_PATH=/auth`）；issuer 与授权/token/JWKS 端点都建立在它之上 |
| `issuer` | `https://<domain>/auth/realms/myrix` | `MYRIX_OIDC_ISSUER`；`apps/bff/src/oidc.ts` 要求发现结果与它逐字节相等 |
| `redirectUri` | `https://<domain>/api/v1/auth/callback` | `new URL("/api/v1/auth/callback", origin)`（`apps/bff/src/oidc.ts`） |
| `webOrigins` | `["https://<domain>"]` | BFF 只接受同源浏览器请求（用 origin，不含 `/auth`） |

> **`origin` 与 `keycloakBaseUrl` 是两个不同概念，绝不能互相替代。**
> 浏览器 origin 不含路径；Keycloak 基础 URL 必须含 `/auth`。混用会让
> `webOrigins`/回调错位，或让 discovery 发布缺少 `/auth` 的 issuer（见 §3.1）。

### 1.2 返回的接口（全部为纯数据或纯字符串）

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `origin` / `keycloakBaseUrl` / `issuer` / `redirectUri` / `webOrigins` | string / string[] | 地址契约，直接对照 BFF 环境；`origin` 无路径，`keycloakBaseUrl` 含 `/auth` |
| `nginxSite` | string | 宿主 Nginx 站点或片段，见第 3 节 |
| `nginxSiteType` | `"server" \| "snippet"` | 生成的是完整站点还是 location 片段 |
| `deniedPaths` | string[] | 公网拒绝前缀（默认 `/auth/admin`、`/auth/realms/master`） |
| `keycloakHostPort` / `bffHostPort` | number | 宿主回环端口（默认 18080 / 8787） |
| `keycloakPublicEnv` | Record<string,string> | 非密 Keycloak 环境，可安全进日志 |
| `keycloakSecretEnv` | Record<string,string> | 含数据库口令与 bootstrap admin 口令 |
| `realmImportJson` / `realmImport` / `realmImportFileName` | string / object / string | realm 导入文件内容与文件名 |
| `keycloakDbInitSql` | string | 独立库与低权角色的初始化 SQL（含明文口令，仅作手工示例） |
| `bffOidcEnv` | Record<string,string> | 直接喂给 BFF 的 OIDC 环境 |
| `ownerSubject` | `{ issuer, subject }` | 要写入 `myrix_auth.subjects` 的那一行 |
| `compose` | ComposeFragment | `keycloak` 服务片段，见第 4 节 |
| `bootstrap` | `{ importRealm, start }` | 两者都等于 `["start","--optimized","--import-realm"]`（见第 7 节） |
| `artifacts` | Record<string,string> | 各生成物在 compose 里的建议挂载路径与站点落点 |
| `notes` | string[] | 非密核对要点（不含任何 secret） |

辅助导出：`renderKeycloakEnvFile(config, { redact: true })`（可安全写日志）、
`describeAuthConfig(config)`（只含非密事实）、`renderNginxSite(...)`（供独立测试调用）。

`bffOidcEnv` 直接喂给 BFF（`MYRIX_AUTH_MODE=oidc`，**不含** `MYRIX_DEV_USERS`）。

### 1.3 BFF 接入（登录能成功的前提）

`apps/bff/src/auth-store.ts` 的 `resolveSubject(issuer, subject)` **只做查表**：首次登录不会自动入租户。
Lead 必须用迁移凭据预置：

```sql
-- 用 MYRIX_MIGRATE_DATABASE_URL（绝不复用运行期角色）执行
INSERT INTO myrix_auth.subjects (issuer, subject, tenant_id, user_id)
VALUES ('https://<domain>/auth/realms/myrix', '<ownerId>', '<tenantId>', '<userId>')
ON CONFLICT (issuer, subject) DO NOTHING;
```

`tenant_id` / `user_id` 必须已存在于平台租户/成员表，否则 `identity(actor)` 返回空，回调落到 403 `not_provisioned`。
运行期角色对 `myrix_auth.subjects` 只有 `SELECT`（`apps/bff/src/auth-store.ts` 有意如此）。

## 2. 镜像：CI 预构建的不可变生产镜像

- Keycloak 镜像由 Lead 的 `deploy/images/Dockerfile.keycloak` 构建，**只在 GitHub Actions 里**执行
  `kc.sh build`；镜像以 `quay.io/keycloak/keycloak:26.8.0` 的固定 digest 为底，
  预置 `KC_DB=postgres`、`KC_HEALTH_ENABLED=true`、`KC_METRICS_ENABLED=false`、
  `KC_HTTP_RELATIVE_PATH=/auth`、`KC_HTTP_MANAGEMENT_RELATIVE_PATH=/`，
  默认 `CMD start --optimized --import-realm`。
- **build-time 与 runtime 必须逐字节一致**：`KC_METRICS_ENABLED` 与 `KC_HEALTH_ENABLED` 都是
  build-time 选项，会被 `kc.sh build` 持久化进优化镜像。`start --optimized` 启动时会比对运行期
  环境与镜像里持久化的值，只要有一项不同就直接退出（VPS 上表现为容器 `exit 2` 反复重启，
  且唯一日志就是
  `The following build time options have values that differ from what is persisted ... kc.metrics-enabled`）。
  本目录的 `keycloakPublicEnv` 显式给出 `KC_METRICS_ENABLED=false`，因此镜像也**必须**在
  `kc.sh build` 之前预置同一个 `false`：既不能省略（省略即"未持久化"，与运行期的 `false` 不一致），
  也不能改成 `true`（那会打开此前关闭的 metrics）。回归测试
  `tests/containers/keycloak-image.test.mjs` 同时比对 Dockerfile 的显式 build-time 值与工厂生成
  的运行期默认值，缺任一侧的 `false` 都会失败。修复路径是提交源码 → PR → CI → 合并 master →
  用 GitHub Actions 重新发布四个镜像，**不是**在 VPS 上 `kc.sh build` 或在运行期打开 metrics。
- 发布引用是 `docker.io/hewenyulucky/myrix:keycloak-sha-<40hex>`（或 digest）。
  bff / gateway / cell 来自同一仓库、各 component 前缀。工厂接受这种 immutable 生产镜像，
  **不要求**镜像名形如 `keycloak:<semver>`。
- **所有官方 Myrix 镜像都必须先合并 master，再由 GitHub Actions 构建**；本目录不本地构建镜像、
  不推镜像、不部署，只提供配置与 argv。首次部署镜像是否可用仍需按第 10 节验收。
- 工厂要求完整 patch tag 或 `sha256:` 摘要，拒绝 `latest`/`stable`/`edge`/`2`/`2.10` 这类浮动引用。
  官方 postgres 使用显式 pin。
- **容器启动时绝不执行 `kc.sh build`**：`command` 与 `bootstrap` 里都没有 `build`。
  任何一次性容器也不得再 build。

## 3. 宿主 Nginx 路由与暴露面

```
公网 80/443 ──> 宿主 Nginx ──┬─ /auth/admin/**          -> 404（永不代理到 Keycloak 管理面）
                             ├─ /auth/realms/master/**  -> 404（master realm 不含 BFF 需要的东西）
                             ├─ /auth  /auth/**         -> 127.0.0.1:18080（Keycloak）
                             ├─ /api/v1/auth/callback   -> 127.0.0.1:8787（精确回调，显式保留）
                             ├─ /api/v1/sessions/**     -> 127.0.0.1:8787（SSE，proxy_buffering off）
                             └─ 其它                    -> 127.0.0.1:8787（BFF）
```

- `nginxSiteType: "server"`（默认）输出**完整站点**：80 端口保留 `/.well-known/acme-challenge/`
  可配置 webroot，其余 301 到 HTTPS；443 端口列出证书路径、安全响应头与全部路由。
  **它只适合全新站点**：目标机已有站点时不要直接覆盖。
- `nginxSiteType: "snippet"` 只输出 location 块，供你并进已有的 `server {}`；片段**不含**
  `listen`、证书、站点名与跳转（不会有模板指令与真实配置打架）。
- **宿主已存在站点时的推荐主路径是 `snippet`**（例如传 `MYRIX_NGINX_SITE_TYPE=snippet`）：
  把片段里的 location 合并进现有的 443 `server` 块，从而保留该站点既有的
  **TLS 配置、ACME/证书续期、Cloudflare 之类 allowlist、以及 query-free 日志**。
  合并后必须 `nginx -t` 通过再 `reload`；**不要**用生成的完整 server 模板覆盖整个已有站点
  （会一并丢掉上述既有配置）。通用 `server` 模板仅供**全新**站点使用。
- **站点名默认是占位符** `MYRIX_PUBLIC_DOMAIN`，不是一个真实域名：生成物因此可以直接进仓库与文档。
  集成时显式传 `nginxSiteDomain`，或对生成文件做一次替换。
- **不读取、不生成、不校验任何证书或私钥**；证书路径只是写进配置的字符串，由宿主的既有 ACME 流程管理。
- 转发头逐条显式固定，且**不信任客户端伪造链**：

  ```nginx
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  ```

  不使用 `$proxy_add_x_forwarded_for`，也不使用 `$scheme`（否则 HTTP 请求能伪装成 https）。
- **刻意关闭 access log**：`/api/v1/auth/callback?code=...` 会把一次性授权码写进磁盘。
  需要日志时请自行加脱敏方案，不要直接打开 access log。
- Keycloak **只发布宿主回环** `127.0.0.1:18080 -> 8080`；管理端口 `9000`（health/metrics）
  **不发布**，只在容器内被健康检查访问。BFF 仍是 `127.0.0.1:8787`。两者都只能经宿主 Nginx 到达。
- `KC_PROXY_HEADERS=xforwarded` 让 Keycloak 采信上面那组转发头；
  `KC_HTTP_MANAGEMENT_RELATIVE_PATH=/` 让管理端点保持在 `/health/*`。

### 3.1 修复后的确切配置：`KC_HOSTNAME` 必须含 `/auth`

**症状（已确认的生产故障）**：Keycloak 26.8.0 优化镜像健康、网关/Cell/PG 正常、
BFF 的库与 RLS 检查全过，但公共 OIDC discovery 返回 HTTP 200 而 `issuer` 不匹配：
发现问题在 `/auth/realms/myrix/.well-known/openid-configuration`，
却把它公布为 `https://<domain>/realms/myrix`（authorization/token/JWKS 也缺 `/auth`），
`createOidcAdapter` 因此拒绝启动。

**根因**：Keycloak **不会**把 `KC_HTTP_RELATIVE_PATH=/auth` 自动拼进 `KC_HOSTNAME`。
只给裸 origin 时，Keycloak 用 hostname + realm 拼 issuer，于是 `/auth` 丢失。

**修复**：工厂把 `KC_HOSTNAME` 从裸 origin 改为**含 `/auth` 的完整基础 URL**：

```yaml
# renderKeycloakEnvFile() 写入 auth/keycloak.env（compose.auth.yml 用 env_file 承载）
KC_HTTP_RELATIVE_PATH: "/auth"
KC_HOSTNAME: "https://<domain>/auth"   # 修复：以前是 https://<domain>（缺 /auth）
KC_PROXY_HEADERS: "xforwarded"
```

由此得到的规范端点（与 `MYRIX_OIDC_ISSUER` 逐字节一致）：

| 端点 | 值 |
| --- | --- |
| issuer | `https://<domain>/auth/realms/myrix` |
| authorization | `https://<domain>/auth/realms/myrix/protocol/openid-connect/auth` |
| token | `https://<domain>/auth/realms/myrix/protocol/openid-connect/token` |
| JWKS | `https://<domain>/auth/realms/myrix/protocol/openid-connect/certs` |

**这不是新的授权决策**：没有新增/放宽任何放行路径，也没有改 realm、owner UUID、
凭据、`redirectUri`、`webOrigins` 或数据库 subject 映射。它只是让 Keycloak
**遵守既有的规范 issuer 契约**（`https://<domain>/auth/realms/myrix`）。
浏览器 origin 仍是 `https://<domain>`（不含 `/auth`），`webOrigins` 与回调继续用它；
`/auth/admin`、`/auth/realms/master`、默认拒绝清单与端口拓扑全部不变。
回归见 §11 的“公共 origin 与 Keycloak 基础 URL 是两个不同值”与
“每个装配变体都从已发射 env 重建出 /auth 下的 issuer 与端点”。

> **不要**用 `frontendUrl`（realm 级）作为绕行修复：那是另一条配置来源，
> 会与镜像 build-time 的 `KC_HTTP_RELATIVE_PATH` 和宿主路由产生第二套真相。

集成由 Lead 负责（本目录不改 VPS）：把片段合并进已有站点（或把全新站点文件放进 `conf.d/`），
`nginx -t` 通过后再 `reload`；既有站点的备份与灰度也由 Lead 另行安排，**不去实际 VPS 验证**。

## 4. 与 `deploy/vps/compose.yml` 的合并

```bash
docker compose -f deploy/vps/compose.yml -f deploy/auth/compose.auth.yml up -d
```

`compose.auth.yml` 只定义 `keycloak` **一个**服务，且：

1. **keycloak 是新服务**，不在基底里，因此本片段的数组（`cap_drop` / `security_opt` /
   `tmpfs` / `ports` / `volumes`）不会与基底的同名数组拼接，**不需要** `!override`；
2. **不重复声明基底已有的网络**：基底用 `name: myrix-vps` 固定了真实网络名，
   片段再声明会把它覆盖掉 —— keycloak 直接加入同名网络 `myrix`。
   工厂的 `compose.networks` 因此默认为空（想独立使用时可传 `declareNetwork: true`）；
3. **不重复基底的服务与全局锚点**：没有 `caddy`、没有 `postgres`/`bff`/`cell`、
   没有 `x-hardening`、没有重复的 `security_opt` 全局数组；keycloak 只**引用**基底的
   `provision:` job 作为前置依赖，不重新定义它；
4. `pids` 只写在 `deploy.resources.limits` 里，绝不与顶层 `pids_limit` 并存
   （compose 会直接报 `can't set distinct values`）。

合并后已核对（工厂输出与参考片段一致）：`read_only: true`、`user: "1000:1000"`、
`cap_drop: [ALL]`、`KC_HTTP_RELATIVE_PATH=/auth`、`KC_HOSTNAME=https://<domain>/auth`
（含 `/auth`，见 §3.1）、`KC_HTTP_MANAGEMENT_RELATIVE_PATH=/`、
`KC_PROXY_HEADERS=xforwarded`、命令为 `start --optimized --import-realm`（见第 7 节）、
端口只有 `127.0.0.1:18080:8080`。

### 4.1 独立 Keycloak 库/角色的前置 job

同机 Compose 里，独立 `keycloak` 库与低权角色由基底的**一次性 `provision` job** 显式创建
（`deploy/vps/compose.yml` 确有该服务）。因此工厂产出的 keycloak 服务：

```yaml
depends_on:
  postgres:
    condition: service_healthy
  provision:
    condition: service_completed_successfully
```

**不是应用启动时自动迁移**：keycloak 必须等 provision 成功退出后才连库，否则会以
`FATAL: role "keycloak" does not exist` 反复重启。工厂提供可选 `provisionService`
（默认 `provision`）以对齐基底的 job 名，不得与 `keycloakService`/`postgresService` 撞名。

`keycloakDbInitSql` 只是**单独手工**执行的等价示例：手工执行必须用**专用 PG 管理员连接串**
（如 `MYRIX_PG_ADMIN_DATABASE_URL`），**绝不**用业务迁移角色 `myrix_migrator`
（它没有 `CREATEDB`，且按职责分离也不得承载 Keycloak 库）。

## 5. 运行身份与只读根文件系统

Keycloak 的 rootfs 是**只读**的，因此容器里只有两个可写点，都是 tmpfs：

| 可写点 | 挂载 | 用途 |
| --- | --- | --- |
| `/tmp` | `tmpfs, noexec, nosuid, size=64m, mode=1777` | Quarkus/JVM 运行期临时文件 |
| `/opt/keycloak/data` | `tmpfs, noexec, nosuid, size=64m, mode=0700, uid=1000` | Keycloak 运行期数据目录 |

realm 导入以只读子挂载落在 `data/import` 之下：
`./auth/realm-myrix.json:/opt/keycloak/data/import/realm-myrix.json:ro`。
这样运行期既不会去写只读目录，导入文件也不会被改写。进程以 `1000:1000` 运行，
`cap_drop: [ALL]` + `no-new-privileges:true`，不需要任何 capability。

### 5.1 realm 导入文件的属主（容器启动前必须修）

realm JSON 里含**初始 owner 密码**与 **client secret**，而 Keycloak 容器以 **UID 1000**
运行；宿主上的 ubuntu 用户不一定是 1000，脚本渲染出的文件默认属于**执行渲染的宿主用户**。
因此部署者必须在容器启动前，**只给 realm import 这一个 inode** 改属主与权限：

```bash
# 仅针对 realm 导入文件这一个 inode；宿主父目录保持 0700，不要动其它文件。
sudo chown 1000:1000 deploy/auth/generated/realm-myrix.json
sudo chmod 0600       deploy/auth/generated/realm-myrix.json
```

- **不要** `chmod -R 777 deploy/auth/generated`，也**不要**把整个目录的属主改成 1000：
  那会把 `keycloak.env` / `bff-oidc.env` / `keycloak-db-init.sql` 里的其它秘密一并暴露给 Cell。
- 生成脚本仍以 0600/0700 落盘，且**不**自动 chown 成生产 user —— 这是刻意的：
  仓库里的 renderer 在本机跑，不知道、也不该猜测生产宿主的 UID 分配。
- 只有 realm 导入文件需要 1000 可读；其它含密文件保持渲染用户所有、0600 即可。

## 6. 首次初始化

```bash
# 0) 生成配置（示例；所有值必须显式提供，无默认；默认不覆盖既有文件）
MYRIX_DOMAIN=br.example.test \
MYRIX_OIDC_CLIENT_SECRET=... MYRIX_OWNER_ID=<uuid> MYRIX_OWNER_USERNAME=owner \
MYRIX_OWNER_PASSWORD=... KEYCLOAK_DB_PASSWORD=... KEYCLOAK_ADMIN_USERNAME=kcadmin \
KEYCLOAK_ADMIN_PASSWORD=... \
KEYCLOAK_IMAGE=docker.io/hewenyulucky/myrix:keycloak-sha-<40hex> \
POSTGRES_IMAGE=postgres:17.6-alpine \
node deploy/auth/render-auth.mjs --out deploy/auth/generated

# 1) 容器启动前：仅给 realm import 文件这一个 inode 设 1000:1000 / 0600（见 5.1）
sudo chown 1000:1000 deploy/auth/generated/realm-myrix.json
sudo chmod 0600       deploy/auth/generated/realm-myrix.json

# 2) 一次 `up -d` 即可：基底的 provision job 先建独立库/角色，
#    keycloak 依赖它成功退出后再以 start --optimized --import-realm 启动并导入 realm。
docker compose -f <lead-compose> -f deploy/auth/compose.auth.yml up -d
```

**首次导入不需要阻塞式的 `run --rm ... start --import-realm`**：那其实是一个长期前台服务器，
永远不会自己退出，把部署脚本卡住；而常规 `up -d` 的启动命令本身就带 `--import-realm`，
在 realm 缺失时会完成导入（见第 7 节）。

**数据库授权不是应用启动自动迁移**：独立 `keycloak` 库/角色由基底的 `provision` 一次性 job
显式创建，keycloak 通过 `depends_on: service_completed_successfully` 等它完成；
单独手工执行时必须用专用 PG 管理员连接串，细节见 4.1 与第 8 节。

## 7. Realm 通过 startup import 导入（已存在则跳过）

`createAuthConfig().bootstrap` 的两个字段现在**是同一个 argv**：

- `start = ["start", "--optimized", "--import-realm"]`：唯一启动命令，写入 `compose.command`，
  并与 Lead 的 `deploy/images/Dockerfile.keycloak` 的 `CMD` 一致；
- `importRealm`：**为兼容早期调用方而保留**，值相同；不再需要用它做一次阻塞式的
  `docker compose run --rm keycloak start --optimized --import-realm`
  —— 那其实是个长期前台服务器，不会自己退出，会把部署脚本卡住。常规 `up -d` 即可。

Keycloak 的 startup import 是**“创建/跳过”语义**：realm 已存在时整段导入被跳过，
**不会**覆盖已有的用户、密码或 client secret。所以：

1. 首次 `up -d`：realm 不存在 → 执行导入，创建 realm / client / owner（含临时密码）；
2. 正常重启或重建：realm 已存在 → startup import 跳过，**不会**重置用户或密码
   —— 即使启动命令一直带着 `--import-realm` 也如此。"日常带 import 会重置密码"是**错误**解释，
   已被移除；
3. **绝不**改用 `kc.sh import --file ... --override`（offline import）之类的强制覆盖路径，
   也绝不在容器里 `kc.sh build`（build 只能在 GitHub Actions 里做）；
4. 改了 realm JSON 后重启也**不会**生效 —— 需要改配置时用管理 API / 管理控制台显式操作；
5. 若确实要重来，必须先备份并删除 Keycloak 的数据（`keycloak` 库）后再导入，
   **绝不要**写任何 `rm -rf` 数据卷的脚本；
6. 临时密码只在首次导入时写入。owner 首次登录被 `UPDATE_PASSWORD` 拦下改密后，
   仓库里的 realm JSON 与现实就脱钩了。

> **待真实镜像验收**：以上“首次导入成功 / 改密后重启不重置”均来自 Keycloak 的
> startup-import 语义推导，**尚未**在合并 master 后由 GitHub Actions 构建的官方 Myrix
> 镜像上实测。上线前必须按第 10 节逐条核对，本目录不声称已经证明。

## 8. 数据库隔离

- 独立数据库 `keycloak`，独立角色 `keycloak`（`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`）。
- 创建走基底的**显式 `provision` 一次性 job**（keycloak 依赖它成功退出），**不是**应用启动自动迁移。
- 库口令**只有** Keycloak 服务知道：不进 BFF/Cell/Gateway 环境，不进镜像层，不进 CI 日志。
- 工厂拒绝把 `postgres` 或调用方 `reservedDbUsers` 里列出的任何名字当作 `keycloakDbUser` / `keycloakDb`。
- `keycloakDbInitSql` 含明文口令，仅供**单独手工**执行的等价示例：写进 0600 文件、
  路径被 `.gitignore` 覆盖，用完即删；执行必须用**专用 PG 管理员连接串**，
  **绝不**用业务迁移角色 `myrix_migrator`（它没有 `CREATEDB`，且按职责分离不该碰 IdP 库）。

## 9. 安全性质（有测试守住）

- **Authorization Code + PKCE(S256)**：client 属性 `pkce.code.challenge.method=S256`，
  `token.endpoint.auth.method=client_secret_post`，scope 只开 `openid profile`。
- **confidential client**：`publicClient=false`，带 secret；`implicitFlowEnabled=false`、
  `directAccessGrantsEnabled=false`、`serviceAccountsEnabled=false`（关闭 ROPC）。
- **禁止自助注册**：`registrationAllowed=false`、`duplicateEmailsAllowed=false`、
  `resetPasswordAllowed=false`、`verifyEmail=false`（首版无 SMTP，不能挂 `VERIFY_EMAIL`）。
- **临时初始密码**：owner 由 realm 导入创建，`requiredActions=["UPDATE_PASSWORD"]`，
  凭据 `temporary: true`；其 `id` 就是 ID Token 的 `sub`，也是 `ownerSubject.subject`。
- **管理面不可达**：`/auth/admin` 与 `/auth/realms/master`（含全部子路径）在公网返回 404。
- **秘密不外泄**：`describeAuthConfig`、`notes`、错误信息与脱敏 env 渲染都不含任何 secret
  （有负例测试）。

## 10. 必须由有宿主机/镜像的人验证的清单（本次为纯离线交付，未执行）

以下结论来自配置推导而非实测。**上线前**必须对着最终固定的镜像与真实 VPS 逐条验证：

1. **issuer 精确匹配**：`curl -s https://<domain>/auth/realms/myrix/.well-known/openid-configuration | jq -r .issuer`
   必须**逐字节**等于 `https://<domain>/auth/realms/myrix`；否则 `apps/bff/src/oidc.ts` 会拒绝。
   同一个 `jq` 里还要核对 `authorization_endpoint` / `token_endpoint` / `jwks_uri`
   都带 `/auth` 前缀（见 §3.1），它们是同一个 `KC_HOSTNAME` 基础 URL 推导出来的。
2. **管理端点可用**：容器内 `curl -fsS http://127.0.0.1:9000/health/ready` 返回 `UP`；
   宿主上 `curl -sI http://127.0.0.1:18080/auth/realms/myrix/.well-known/openid-configuration` 为 200。
3. **首次导入 / 改密 / 重启不重置（用真实 Actions 镜像验收，本目录未实测）**：
   在合并 master 后由 GitHub Actions 构建的官方 Myrix 镜像上，
   (a) 空库首次 `up -d` 后 realm/client/owner 存在；
   (b) 改一次 owner 密码并重启（命令仍带 `--import-realm`），确认密码**没有**被重置回 JSON 值。
   这两点是 startup-import 语义推导的结论，尚未实测，不得当作已证明。
4. **provision 前置生效**：全新数据卷 `up -d` 时，keycloak 在 `provision` 成功退出后才启动，
   不出现 `FATAL: role "keycloak" does not exist`。
5. **realm 属主修复**：未 chown 到 1000 时 Keycloak 因读不到 import 文件而失败；
   `sudo chown 1000:1000` + `0600` 后正常导入（宿主父目录保持 0700）。
6. **Nginx 配置合法**：`nginx -t` 通过；`/auth/admin/` 与 `/auth/realms/master/...` 返回 404、
   `/auth/realms/myrix/*` 可达、`/api/v1/auth/callback` 精确命中 BFF。
   已有站点上必须用 snippet 合并而非覆盖：确认既有 TLS/ACME/Cloudflare allowlist/日志仍在。
7. **只读 rootfs 可写点**：`docker run --rm --entrypoint id <keycloak-image>` 应为 1000；
   `read_only: true` + 两个 tmpfs 下能正常启动并保持运行。
8. **管理端口未发布**：`ss -ltnp` 在宿主上只看到 `127.0.0.1:18080` 与 `127.0.0.1:8787`，
   没有 9000，也没有 `0.0.0.0` 上的 Keycloak 端口。
9. **`user.id` 就是 `sub`**：一次真实登录后核对 ID Token 的 `sub` 等于 `ownerId`。
10. **SSE 不被缓冲**：浏览器会话事件流能持续增量到达（Nginx 侧 `proxy_buffering off` 生效）。
11. **X-Forwarded 不可伪造**：带伪造 `X-Forwarded-For` / `X-Forwarded-Proto: http` 的请求，
    到达上游时仍是 `X-Forwarded-Proto: https` 且 `X-Forwarded-For` 只有真实对端地址。

## 11. 测试

```bash
node --test tests/auth-deploy/*.test.mjs
```

`auth-config.test.mjs` 覆盖：issuer/redirect/callback 契约、realm 关闭注册与 ROPC、
owner 确定 UUID 与临时密码、`/auth` 相对路径与管理根路径、Keycloak 只读 + tmpfs 可写点 +
导入只读挂载、只发布回环 18080（9000 不发布）、不可变镜像 pin、Nginx 路由/拒绝/转发头/SSE/ACME/跳转、
snippet 模式、库隔离 + provision 前置依赖、startup import 不覆盖语义、纯函数与无 `latest`、
`compose.auth.yml` 参考片段的关键安全字段不漂移，以及
“secret 不进入 describe/notes/错误信息/脱敏输出”的负例。

其中三条是本次线上 issuer 故障的回归（见 §3.1）：

- **公共 origin 与 Keycloak 基础 URL 是两个不同的值**：断言
  `keycloakBaseUrl === origin + KC_HTTP_RELATIVE_PATH`、`origin` 无路径、
  `webOrigins`/`redirectUri` 用 origin 而 `issuer` 用 `keycloakBaseUrl`；
- **每个装配变体都从已发射 env 重建出 /auth 下的 issuer 与端点**：对默认、snippet、
  换域名、换端口、IPv6 回环、换挂载目录、declareNetwork、长域名等变体，断言
  `KC_HOSTNAME` 含且仅含一次 `/auth`，并用它重建出 `/auth/realms/myrix` 下的
  issuer/authorization/token/JWKS，且与 `MYRIX_OIDC_ISSUER` 逐字节一致；
  同时用“把 `KC_HOSTNAME` 改回裸 origin”的负例证明该回归能捕获故障；
- **不重复 /auth、不污染浏览器字段**：`KC_HOSTNAME` 只出现一次 `/auth`，
  `origin`/`webOrigins`/`redirectUri`/realm 导入里都不得出现 `/auth/realms`。

`render-auth.test.mjs` 是 renderer 的 CLI 回归（子进程，输出只写 `os.tmpdir()`）：
首次渲染的 0700/0600、**默认 no-clobber**（重复运行拒绝且既有文件 bytes 不变）、
危险 basename 在创建目录前拒绝、已有目标含 symlink 也拒绝、以及
stdout/stderr 在任何路径都**不泄露** secret 值。

测试**不**打印 secret、**不**读取真实 `.env` 或进程里的真实秘密（CLI 用显式假环境）、
**不**写仓库内文件、**不**拉镜像、**不**启动服务、**不**做真实域名或证书操作，
也不要求 `docker` / `nginx` 可执行文件存在。

另有一条镜像回归在 `tests/containers/keycloak-image.test.mjs`（CI 的
`node --test tests/containers/*.test.mjs` 一并跑）：它解析 `deploy/images/Dockerfile.keycloak`
在 `kc.sh build` 之前的 `ENV` 块，与该工厂 `keycloakPublicEnv` 生成的运行期默认值逐项比对
`KC_DB` / `KC_HEALTH_ENABLED` / `KC_METRICS_ENABLED`，缺任一侧的显式 `false` 即失败
（对应第 2 节的 `start --optimized` 启动失败）。

## 12. 明确的非目标

- 不引入其它反代或证书组件，不生成其配置，不保留端口模式兼容层。
- 没有 `chat/completions` 协议路径，也不新增任何兼容入口。
- 没有开发登录：`bffOidcEnv` 不含 `MYRIX_DEV_USERS`，OIDC 模式下 BFF 会主动拒绝它。
- 不做外部 SSO（飞书/企微/Authing）适配；默认 realm 与 BFF 登录不依赖任何第三方 IdP。
- 不做 LDAP/AD 联邦、不做邮件（SMTP）与自助找回密码。
- 不引入多租户自动开户：成员一律由迁移凭据显式预置。
- 本目录不产生任何真实生产凭据、域名或证书；示例一律用 RFC 保留域名 `*.example.test`。
