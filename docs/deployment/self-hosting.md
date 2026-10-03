# Myrix 单机 VPS 部署（Docker Compose + 宿主 Nginx + 同机 Keycloak）

首版部署目标是一台 VPS，不是 Kubernetes。部署编排提供**真正单机**的编排：
一台 Postgres 17（持久卷）、四个 Myrix 运行镜像（BFF+works、模型网关、Cell、
Keycloak）。**不使用 CellManager / Helm / Kubernetes**。

- 编排：[compose.yml](<../../deploy/vps/compose.yml>)（Keycloak 由 [../auth/compose.auth.yml](<../../deploy/auth/compose.auth.yml>) 覆盖片段引入）
- 初始化器：[init.mjs](<../../deploy/vps/init.mjs>)（生成全部私有配置与一次性 SQL，不连数据库）
- 备份/恢复：[backup.sh](<../../deploy/vps/backup.sh>) / [restore.sh](<../../deploy/vps/restore.sh>)
- 测试：`node --test tests/vps/*.test.mjs`

**没有 Caddy**：TLS 终止与公网路由由**宿主上既有的 Nginx**负责，部署编排不声明
`caddy` 服务、不生成 Caddyfile、没有 `--profile tls` 分支。域名与证书同样由宿主
既有流程管理，本仓库不申请、不覆盖、也不复制任何证书或私钥。

---

## 0. 架构与秘密边界

| 服务 | 镜像 target | 持有 | 不持有 |
| --- | --- | --- | --- |
| `bff` | `bff` | 业务/认证低权 DB、OIDC client secret、ES256 签名私钥、Cell 凭据 | 上游模型密钥 |
| `gateway` | `gateway` | 上游 Responses 密钥、账本低权 DB | 签名私钥、Cell 令牌明文 |
| `cell-1` | `cell` | 自己的租户 id、自己的 works/gateway 令牌 | DB、上游密钥、签名私钥、OIDC secret |
| `keycloak` | `keycloak` | Keycloak 独立库口令、bootstrap admin 口令 | 业务库、签名私钥、上游密钥 |

- **所有服务都在同一个 `myrix` 网络**（`name: myrix-vps`）：postgres、provision、
  migrate、auth、grants、bff、gateway、cell-1 与覆盖片段里的 keycloak 都显式
  `networks: [myrix]`。不声明网络的服务会落到 Compose 自动创建的 default 网络，
  那样一次性 job 根本连不上 postgres。
- **BFF 固定发布 `127.0.0.1:8787`**：compose 里写死，没有 `MYRIX_BFF_BIND` 之类
  的可选公网 bind；works 监听 8791、gateway 8790、cell 8404 都只在编排内网。
- **Keycloak 固定发布 `127.0.0.1:18080 -> 8080`**；管理端口 9000 绝不发布。
- 浏览器只访问 BFF，公网入口只有宿主 Nginx 的 443。

镜像来自 `docker.io/hewenyulucky/myrix`，tag 形如
`bff-sha-<40位GitSHA>`、`gateway-sha-<40位GitSHA>`、`cell-sha-<40位GitSHA>`、
`keycloak-sha-<40位GitSHA>`。**四个镜像必须来自同一个完整 commit SHA**：
初始化器会逐一核对，混用不同 SHA 直接拒绝生成配置。

---

## 1. 首次启动

### 1.1 前置

- Docker 与 Docker Compose v2；
- 宿主机上**已有的 Nginx**（已监听 80/443），域名已解析到本机，证书由既有
  ACME 流程管理；
- 一个**已验证支持 OpenAI Responses** 的上游端点（完整 `/responses` URL）与模型名；
- **不需要**外部 OIDC：Keycloak 与本栈同机运行，realm/owner/client secret 全部由
  初始化器生成；也不需要用户提供 client secret 或 owner subject。

> 本仓库禁止 `chat/completions`。上游配置不是 `/responses` 结尾会在初始化时直接失败；
> 不提供协议转换或回退。

### 1.2 生成配置（不连数据库、不部署）

在仓库根目录：

```sh
export MYRIX_UPSTREAM_API_KEY='<上游 Responses 密钥>'

node deploy/vps/init.mjs \
  --out deploy/vps \
  --domain myrix.example.com --origin https://myrix.example.com \
  --bff-image      docker.io/hewenyulucky/myrix:bff-sha-<40hex> \
  --gateway-image  docker.io/hewenyulucky/myrix:gateway-sha-<40hex> \
  --cell-image     docker.io/hewenyulucky/myrix:cell-sha-<40hex> \
  --keycloak-image docker.io/hewenyulucky/myrix:keycloak-sha-<40hex> \
  --upstream-url https://api.example.com/v1/responses --upstream-model your-responses-model \
  --cells 1
```

四个 `<40hex>` 必须相同。`--cells` 只接受 1（见 §5）。

生成器会：

1. 造 ES256(P-256) 签名密钥与公开 JWKS、随机 tenant UUID 与 Cell 令牌；
2. 生成**随机且稳定**的 owner UUID（同时是 Keycloak 的 `sub` 与业务 `user_id`）、
   临时随机 owner 口令、OIDC client secret、Keycloak 库口令与 bootstrap admin 口令
   （默认用户名 `myrix-owner` / `myrix-admin`）——这些都不需要用户提供，也**不会打印**；
3. 调用 [`deploy/auth/auth-config.ts`](<../../deploy/auth/auth-config.ts>) 的 `createAuthConfig()`，
   由它渲染 realm 导入 JSON、Keycloak `KC_*` 环境与宿主 Nginx 站点片段；
4. 写 `.env`、`secrets/*.env`、`auth/keycloak.env`、`auth/realm-myrix.json`、
   `auth/nginx-myrix.conf`（全部 `0600`）与 `sql/*.sql`；
5. **拒绝覆盖已有文件，不提供 `--force`**。重建会改变 owner UUID、签名密钥、
   Cell 令牌和数据库口令，但 Keycloak 不会重新导入已有 realm，因而不是恢复或升级手段。

生成的 `secrets/`、`auth/keycloak.env`、`auth/realm-myrix.json`、`.env` 与
`sql/` 已被 [.gitignore](<../../deploy/vps/.gitignore>) 忽略，绝不提交。

### 1.3 拉起

Keycloak 与读取私有 SQL 的 `provision` / `grants` 作业以 **UID/GID 1000** 运行。
生成文件是 0600，必须由这个 UID 持有；不能依赖 root 绕过权限（作业已 drop ALL）。
在 VPS 上用 UID 1000 的部署账号生成或接收文件即可；若文件由其他 UID 创建，在
确认下列路径都是本次生成的普通文件后，只调整这些必要输入，不改成全局可读：

```sh
sudo chown 1000:1000 deploy/vps/auth/realm-myrix.json \
  deploy/vps/secrets/postgres-superuser-password deploy/vps/sql/*.sql
sudo chmod 0600 deploy/vps/auth/realm-myrix.json \
  deploy/vps/secrets/postgres-superuser-password deploy/vps/sql/*.sql
# 若 sql/ 为 0700，其目录属主也须为 1000；脚本保持可读，不需要加执行权限。
sudo chown 1000:1000 deploy/vps/sql
```

然后：

```sh
cd deploy/vps
# 首次只起 postgres 与 keycloak：BFF 必须等 Nginx 放通 /auth 后再启动（见下方启动顺序）
docker compose -f compose.yml -f ../auth/compose.auth.yml up -d --wait \
  postgres keycloak
```

**必须同时给出两个文件**：`deploy/auth/compose.auth.yml` 是 Keycloak 的覆盖片段
（`keycloak` 服务、realm 挂载、`127.0.0.1:18080`）。只给基底文件会少掉 IdP，
登录一定失败。

> **启动顺序（重要）**：BFF 启动时会**同步**访问公共 OIDC discovery 并要求
> discovered `issuer` 逐字节等于 `MYRIX_OIDC_ISSUER`（`apps/bff/src/oidc.ts`）。
> 因此**必须先在宿主 Nginx 上放通 Keycloak 的规范 HTTPS `/auth` 路由（§1.4），
> 再启动 BFF**。首次部署推荐分三步，而不是一条命令拉起全部：
>
> ```sh
> # 第 1 步：只起 postgres 与 keycloak（provision 作为依赖会一并运行），不碰 BFF；
> #        migrate/auth/grants 等其余业务作业留到第 3 步完整启动时运行
> docker compose -f compose.yml -f ../auth/compose.auth.yml up -d --wait \
>   postgres keycloak
> # 第 2 步：按 §1.4 集成 Nginx 并 reload，确认公共 discovery 的 issuer 逐字节等于
> #        预期的 MYRIX_OIDC_ISSUER，且 authorization/token/JWKS 端点 URL 都位于该
> #        issuer 之下（带 /auth）
> curl -fsS https://<DOMAIN>/auth/realms/myrix/.well-known/openid-configuration
> # 第 3 步：再启动 BFF/gateway/Cell（此时 discovery 必须已经可达）
> docker compose -f compose.yml -f ../auth/compose.auth.yml up -d --wait
> ```
>
> 若 Nginx 尚未放通 `/auth` 就启动 BFF，BFF 会因拿不到 discovery 或 issuer 不匹配
> 而反复退出——这是预期的 fail-closed 行为，**不要**为此改成内部 HTTP issuer
> 或关闭校验。

`up` 会按顺序跑四个**一次性 job**（都是 `restart: "no"`，常驻服务等它们成功）：

1. `provision`：以超级用户建低权 LOGIN 与迁移角色、转移库 owner，并显式创建
   Keycloak 的**独立库**与低权角色（`sql/05_keycloak_db.sql`，不在迁移脚本里）；
2. `migrate`：以迁移角色调用 `deploy/images/migrate.mjs --target business,gateway`；
3. `auth`：以迁移角色挂载执行 [`deploy/vps/migrate-auth.mjs`](<../../deploy/vps/migrate-auth.mjs>)，
   建 `myrix_auth` schema 并授权；
4. `grants`：以迁移角色做低权授权、登记 Cell 凭据摘要、登记唯一 owner 主体
   （`myrix_auth.subjects` 里显式写入与 Keycloak `sub` 相同的 UUID）。

任一失败都会阻止 BFF/gateway/Cell 启动——不存在“跳过迁移直接起服务”的路径。
Keycloak 显式等待 `postgres: service_healthy` 与 `provision: service_completed_successfully`。
PostgreSQL 和四个运行服务均使用 `restart: unless-stopped`；一次性作业不自动重启。

### 1.4 宿主 Nginx 集成（由部署操作者执行）

初始化器生成的站点片段在 `auth/nginx-myrix.conf`（snippet 模式：只有 `location`
块，不含 `listen`/`ssl_certificate`/`server_name`/跳转）。它把 `/auth` 与 `/auth/`
转到 `127.0.0.1:18080`，其余转到 `127.0.0.1:8787`，并把
`/auth/admin`、`/auth/realms/master` 返回 404。

集成步骤（**由部署操作者在维护窗口执行，不要覆盖既有其他站点**）：

1. **备份**：`cp -a /etc/nginx /root/nginx-backup-$(date +%F)`，并记录当前
   `nginx -T` 输出；
2. 在**已有的、服务本域名的** `server {}` 里 `include` 该片段（或把 location 块
   手工并进该 server），**不要**新建一个占用 80/443 的 server，也不要用本文件
   替换其它站点；站点已有的 `server_name`、TLS 证书路径、ACME 挑战与 allowlist
   全部原样保留；
3. 校验：`nginx -t` 通过后再 `systemctl reload nginx`（不是 restart）；
4. **日志**：回调路径的查询串携带一次性 authorization code，因此不要为本站点打开
   未脱敏的 access log；若确需访问日志，保持宿主既有策略并做查询串脱敏
   （query-free / 只记 `$uri` 不记 `$request_uri`）。不要为了这个站点改动其它
   站点的日志、TLS、ACME 或 allowlist 配置；
5. 回滚：恢复备份的 `/etc/nginx` 后 `nginx -t && systemctl reload nginx`。

**Nginx 必须早于 BFF**：BFF 启动即同步拉取公共 discovery，所以第 2–3 步要在
启动 BFF 之前完成（见 §1.3 的启动顺序）。这段 `/auth` 路由是 BFF 唯一的公网
issuer 入口；Nginx 放通后可用
`curl -fsS https://<DOMAIN>/auth/realms/myrix/.well-known/openid-configuration`
直接确认 issuer 与各端点都带 `/auth`。默认拒绝（`/auth/admin`、
`/auth/realms/master`）、回环发布（`127.0.0.1:18080` 与 `127.0.0.1:8787`）、
现有站点的 allowlist/TLS/ACME 边界全部**保持不变**，也不要为了联调方便
放宽为公网 bind。

若工作台/SSE 等非认证路由需要先退役维护，那是应用层切换：**先让 BFF 依赖的
`/auth` 公网路由可用并把 BFF 起成 healthy，再切回 app/SSE 路由**，不要在
`/auth` 尚不可达时启动 BFF。

BFF 使用公共 DNS 经 HTTPS 访问同一个 issuer，不设置 `extra_hosts` 直连宿主。
现有 Nginx 若只允许 Cloudflare 来源，Docker 网段的直连会被拒绝；不要通过全局
放行 Docker 网段来绕过源站保护。正式启动后还要从 BFF 容器验证公共 discovery 与
后续 token 交换可达；如 CDN 返回验证挑战，应按具体 OIDC 路径修正边缘策略，
不能改成内部 HTTP issuer 或关闭 TLS 校验。

### 1.5 验证

```sh
cd deploy/vps
docker compose -f compose.yml -f ../auth/compose.auth.yml ps   # 常驻服务应 healthy
curl -fsS http://127.0.0.1:8787/healthz                        # BFF 存活
curl -fsS https://<DOMAIN>/auth/realms/myrix/.well-known/openid-configuration
docker compose -f compose.yml -f ../auth/compose.auth.yml logs grants migrate
```

`openid-configuration` 的 `issuer` 必须逐字节等于
`https://<DOMAIN>/auth/realms/myrix`（BFF 会拒绝不匹配的 issuer）；
`authorization_endpoint` / `token_endpoint` / `jwks_uri` 也必须都在 `/auth/realms/myrix`
之下，它们由同一个含 `/auth` 的 `KC_HOSTNAME` 基础 URL 推出（见
[认证装配 §2](<authentication.md#2-origin-与-issuer两个不同值>)）。浏览器打开
`https://<DOMAIN>`，用 `myrix-owner` + 生成时的临时口令登录，首次登录会强制
改密。**单机部署不使用开发登录**。

---

## 2. 镜像来源与上线流程（固定顺序）

不允许在 VPS 或开发机本地 `docker build`。镜像只能来自 GitHub Actions：

1. **PR 检查**：推分支开 PR，等待 `Build and publish containers` 的 `verify` job
   （typecheck / pnpm test / PostgreSQL 测试 / Go 与 Helm 契约）通过。PR 事件
   不会发布镜像。
2. **合并到 master**：`images` job 才会运行，矩阵为
   `bff / gateway / cell / keycloak` 四个组件。
3. **CI 构建**：每个组件都以 `pull: true`、`no-cache: true` 构建
   `linux/amd64,linux/arm64` 双架构清单并推送；随后 CI 自己拉取清单断言两个
   架构都存在。
4. **校验 SHA 镜像**：从 CI 日志/`GITHUB_STEP_SUMMARY` 取得四个组件的
   `@sha256:` 摘要或 `*-sha-<40hex>` tag，确认四个 tag 指向**同一个 commit**。
5. **VPS 部署**：首次部署用初始化器生成配置；升级先确认变更范围、数据库兼容性和维护窗口，停写并完成[联合备份](<backup-restore.md>)。保留全部身份、秘密及既有挂载，不重跑初始化器。更新四个同 SHA 镜像引用并核验摘要；按 Keycloak/公开 issuer 先于 BFF 的顺序重建运行服务，防止意外重跑 provision/migrate/grants。需要迁移时先审查独立执行计划。

回滚不是只换四个 tag：数据库迁移**不可自动回退**，必须先评估旧应用与现有 schema/数据的兼容性；涉及数据恢复时按恢复手册在隔离的空目标演练。保留旧发布目录，私密 bind mount 可能仍引用它们。

---

## 3. 迁移

迁移只在一次性 `migrate` / `auth` job 里、以迁移角色执行；运行服务启动时**不会**
自动迁移，缺少表会拒绝启动。

```sh
cd deploy/vps
docker compose -f compose.yml -f ../auth/compose.auth.yml run --rm migrate   # 业务表 + 网关账本
docker compose -f compose.yml -f ../auth/compose.auth.yml run --rm auth      # myrix_auth schema
docker compose -f compose.yml -f ../auth/compose.auth.yml run --rm grants    # 授权/凭据/owner 登记
docker compose -f compose.yml -f ../auth/compose.auth.yml up -d --wait bff gateway cell-1
```

`auth` job 用镜像中的 `tsx` loader 加载 `apps/bff/src/auth-store.ts`；`pg` 驱动是
**从声明它的 workspace 解析**的（`createRequire(<appRoot>/apps/bff/package.json)`），
仓库根目录没有也不应有 `pg` 依赖。迁移文件一旦发布不可改写（记录内容摘要）；
DDL 漂移会直接报错并要求新增迁移文件。绝不要把迁移连接串
（`secrets/migrator.env`）挂给任何常驻服务。

---

## 4. 备份与恢复

完整维护窗口、空库/空卷前置条件、角色恢复与演练步骤见
[备份与恢复操作手册](<backup-restore.md>)。这些脚本需要 Ubuntu 的 `sha256sum`。

```sh
# 操作者先停本项目除 postgres 外的全部服务/作业，脚本不会代为停机。
sh deploy/vps/backup.sh /secure/backups
# 恢复只接受一个完整备份集，而不是含多套备份的父目录。
sh deploy/vps/restore.sh /secure/backups/<UTC-timestamp>
```

每套备份在独占目录内包含 `myrix.dump`、`keycloak.dump`、`cell-home.tgz`、
`config.tgz`，外加四文件 SHA-256 清单与最后写入的 `SUCCESS`。任一步失败就不算
有效备份。业务库导出必须使用显式备份管理员，不能用被 FORCE RLS 限制的迁移角色。
这不是在线原子热备：只有所有应用写入者停止后才能备份两个库与 Cell。

丢失**配置归档**就无法恢复原有身份：签名私钥、Cell 令牌与数据库口令不在业务库里。
恢复时先人工恢复同套配置，再仅启动 PostgreSQL 和 provision 建空库/角色；不要先
启动全套服务导致迁移或 Keycloak 填满目标库。脚本拒绝非空库、非空 Cell 卷，
不会自动解包私有配置、创建或清空卷。恢复后按操作手册重新执行授权并验证登录。
还须核对 BFF 签名 KID / Cell 公钥集配对，以及 realm owner `id` 与预登记 subject 一致。
脚本回归使用 shell mocks，**不代表真实双库恢复已经验收**。

**禁止**用 `docker compose down -v`、`docker volume rm` 之类的“捷径”来清库或
“重置”：那会连同数据卷一起删除，把恢复变成第二次数据丢失。

---

## 5. 首版初始化范围：1 Cell / 1 tenant / 1 owner

`myrix_auth.subjects` 的主键是 `(issuer, subject)`：同一个 Keycloak 用户无法同时
登记到两个租户——第二条 `insert ... on conflict` 会被唯一键吞掉。因此首版
bootstrap：

- `--cells` 只接受 `1`；`--cells 2` 会**明确失败**，而不是生成一个只有第一个
  Cell 能登录的“伪多租户”部署；
- 初始化只创建一个租户、一个 owner 主体；同租户可由运维显式补员（见[认证装配](<authentication.md#6-身份预登记与补员>)），不需要重跑初始化。真正的多租户切换需要控制面补充显式入口
  （例如每租户独立 issuer，或把 `subjects` 改成允许一个 subject 多租户）。

Cell 的契约与 K8s/镜像一致：UID/GID `65532`，`DSH_HOME=/var/lib/myrix/dsh-home`
（命名卷；镜像已把该目录预创建为 65532 属主，首次挂载即继承），内部 HTTP 默认
拒绝，只有 `MYRIX_CELL_INTERNAL_HTTP_ORIGINS='["http://bff:8791","http://gateway:8790"]'`
里的精确 origin 允许明文 HTTP。`worksOrigin=http://bff:8791`，
`gatewayURL=http://gateway:8790/v1`。

---

## 6. 安全基线（编排已强制）

- BFF / Gateway / Cell / Keycloak：`read_only` 根文件系统、`tmpfs:/tmp`、
  `no-new-privileges`、`cap_drop: ALL`、非 root。Cell UID/GID 为 65532，Keycloak 为 1000。
  PostgreSQL 保留官方入口的 root 初始化后降权与可写 PGDATA，不谎称套用同一基线。
- 只有 BFF（固定 `127.0.0.1:8787`）与 Keycloak（覆盖片段 `127.0.0.1:18080`）
  发布宿主端口，且都只绑回环；postgres/gateway/cell/works 均不发布。
- Postgres 密码经 Docker secret 文件注入（`POSTGRES_PASSWORD_FILE`），不写进 compose。
- 运行角色是真实低权限 LOGIN：`NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS`，
  不是库 owner，也不是迁移角色的成员；启动时由应用自身再做一次
  `assertRuntimeDatabase` 校验。Keycloak 使用**自己的**独立库与低权角色。
- 业务与账本表 `ENABLE + FORCE ROW LEVEL SECURITY`；auth schema 独立授权，
  运行期不能登记 IdP 主体。
- Keycloak 启动**绝不 `kc.sh build`**（已在 CI 镜像里 build 完）；入口是
  `start --optimized --import-realm`。startup import 只导入尚不存在的 realm，
  重启不覆盖既有用户/口令/配置；升级不能用重新生成导入文件来轮换已有秘密。

---

## 7. 已对齐的装配契约与生产验证边界

1. **auth 工厂接口**：部署编排通过 `createAuthConfig()` 消费
   `deploy/auth/auth-config.ts`，合并后配置由真实 `docker compose config` 回归验证。
   生成器先检查全部目标、拒绝 symlink 和覆盖，再以 0600 独占创建；错误固定脱敏。
   它不防御恶意宿主 root，也不声称消除了同 UID 修改父目录的 TOCTOU。
2. **镜像内路径契约**：`migrate` job 执行
   `node /app/deploy/images/migrate.mjs --target business,gateway`（`APP_ROOT=/app`，
   镜像需带 workspace 源码）；`auth` job 把部署编排的
   [`migrate-auth.mjs`](<../../deploy/vps/migrate-auth.mjs>) 只读挂到
   `/app/deploy/images/migrate-auth.mjs` 后执行，并从
   `apps/bff/package.json` 解析 `pg`。BFF 静态资源路径假定为
   `/app/apps/novel-web/dist`。
3. **公网 issuer 可达性**：BFF 通过公共 DNS/HTTPS 访问
   `https://<DOMAIN>/auth/...`，不加 `host-gateway` 覆盖、不绕过源站限制。
   discovery/token 交换、CDN 策略、TLS 与 ACME 都需要在实际 VPS 上验证。
4. **Keycloak 首次导入**：镜像固定启动命令的 startup import 只导入不存在的 realm。
   正式发布后验证管理口健康检查返回 HTTP 200、owner 首次改密、`sub` 与预登记一致、
   重启不重置密码。若 IdP 要求补个人资料，须人工提供，验收不能虚构资料或跳过流程。
5. **健康检查路径**：编排假定 BFF `GET /healthz`、网关 `GET /healthz`、
   Cell `GET /v1/ready`。若镜像改了就绪语义需同步。
6. **Cell 持久卷属主**：依赖镜像在 `/var/lib/myrix/dsh-home` 预创建 65532 属主；
   `Dockerfile.node` 的 `cell` target 已满足，但需在合并后的镜像上复核。
7. **多租户切换**：见 §5，需要控制面设计，部署编排不实现。

---

## 8. 测试

```sh
node --test tests/vps/*.test.mjs
```

覆盖：Cell 绝不携带 upstream key/DB/私钥/OIDC secret、upstream key 只在 gateway、
签名私钥只在 BFF、四个镜像同 SHA 契约、只有一个 Cell/租户、origin 与上游校验的
fail-closed、env_file 多行转义、文件权限 `0600`、覆盖拒绝与越界路径拒绝、
**真实 `docker compose config --format json`** 合并两个文件后的网络/端口/路径/
depends_on，以及备份脚本覆盖 Keycloak 独立库与 Cell 卷。测试不连接数据库、
不启动容器、不调用真实模型。

许可：Apache-2.0（见仓库 `LICENSE`）。
