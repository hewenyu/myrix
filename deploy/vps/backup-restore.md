# 单机 VPS 备份与恢复（backup.sh / restore.sh）

> 仅适用于**单机 Ubuntu VPS** 的 Docker Compose 部署（`deploy/vps/compose.yml` +
> `deploy/auth/compose.auth.yml`）。第 0 节是必须先满足的前置；第 4 节是恢复的
> **唯一正确顺序**，任何"跳步"都会得到半套状态。

## 0. 前置与适用范围

- 宿主机需要 `docker`（compose v2）与 `sha256sum`（`coreutils`，Ubuntu 默认有）。
  本脚本只用 POSIX `sh`，不依赖 `bashism`。
- 命令都在 `deploy/vps/` 下执行（脚本会自己 `cd` 到所在目录）。
- 一次备份 = `backups/<UTC 时间戳>/` 一个唯一子目录，内含**固定六份文件**：

  | 文件 | 内容 | 缺失后果 |
  | --- | --- | --- |
  | `myrix.dump` | 业务库 `myrix`（业务表 + 网关账本 + `myrix_auth` schema） | 业务数据/登录会话全丢 |
  | `keycloak.dump` | Keycloak 独立库 `keycloak`（realm/用户/client/会话） | 无法登录 |
  | `cell-home.tgz` | Cell 持久卷 `myrix-vps_myrix-cell-1-home` | Cell 会话上下文全丢 |
  | `config.tgz` | `.env`、`secrets/`、`sql/`、`auth/` 私有配置 | 签名私钥/Cell 令牌/realm 导入无法重建 |
  | `sha256sums` | 上述四份文件的 SHA-256 清单 | 无法判断备份是否完整 |
  | `SUCCESS` | 成功标记，仅全部成功后才写入 | 恢复脚本据此拒绝恢复 |

- 脚本只覆盖备份与恢复数据库/卷/配置**文件**；**不**负责 Nginx、防火墙、
  DNS、证书、镜像分发。镜像不在备份范围内：必须能从 CI/仓库按 `commitSha`
  重新拉取**同版本**镜像（见主 README 的镜像章节）。

## 1. 一致性模型（重要）

**这不是在线热备，也不是原子一致快照。** 脚本对一致性的处理是：

- 两个库**各自**一次 `pg_dump`（各自 consistent），Cell 卷另起一次 `tar`；
  四份产物之间有**时间差**，所以要靠"先停写"来近似一致。
- 因此操作者必须在备份前**停掉本项目除 postgres 之外的全部容器**，包括
  常驻的 `bff` / `gateway` / `cell-1` / `keycloak` 和一次性 job
  `migrate` / `auth` / `grants`；**postgres 继续运行**（否则无法 dump）。

```sh
cd deploy/vps
docker compose -f compose.yml -f ../auth/compose.auth.yml stop bff gateway cell-1 keycloak
# 一次性 job 若在运行，等它结束（run --rm 的容器会自然退出）
```

`backup.sh` 会自己检查：用 `docker ps` 按 label
`com.docker.compose.project=myrix-vps` 过滤，只要有**除 `postgres` 之外**的服务
处于 `running` 就**拒绝**执行。脚本**不会**替你停任何服务，也不会去动别的
compose 项目。

## 2. 备份

```sh
cd deploy/vps
sh backup.sh /secure/backups        # 绝对路径；默认 ./backups
```

产物：`/secure/backups/<时间戳>/`（目录 `0700`，文件 `0600`）。
脚本**不覆盖已有备份**：同一秒重复执行会创建 `<时间戳>-1` 而不是合并。

**输出目录的所有权规则（重要）**：

- 若 `OUT` **不存在**，脚本以 `0700` 新建（`mkdir -p -m 700`），并拒绝以 `/`
  结尾的路径（避免 `[ -L ]` 之类的检查被 symlink 穿透）。
- 若 `OUT` **已存在**，脚本**绝不 chmod/chown 它**。只接受"非 symlink 的真实
  目录且权限恰为 `0700`"；否则直接失败并让你自己 `chmod 700` 或另选一个私有
  目录。
- 备份集子目录永远新建（`0700`），从不复用。
- **边界**：脚本不防恶意 root，也不防与运行脚本同一 UID 的竞态（同 UID 本来就
  能改这些文件）。它只保证"不误改他人目录、不把秘密写进世界可读的位置"。

**容器产物的所有权（为什么必须容器内收尾）**：`pg_dump` 与 `tar` 都在一次性容器
里以默认 root、默认 umask `0022` 运行；若就这么落盘，宿主 Ubuntu UID 1000 对
root-owned 文件执行 `chmod`/读哈希会直接 `EPERM`。因此每个容器 shell：

1. 先 `umask 077`（宿主 umask 管不到容器，不能依赖它）；
2. 用 `stat -c '%u:%g' /out` 读出挂载目录的**数字属主**；
3. 在容器内 `chmod 600` 产物，再 `chown` 给该数字 UID/GID。

宿主随后才能读哈希、`chmod 600` 并写 `SUCCESS`。Cell 卷数据属 UID `65532` 且目录
`0700`，所以归档那一次**必须**用容器内 root 只读地去读卷（不能图省事加
`--user 1000`）；脚本只读挂载卷，**不改动源卷的 ownership**。

安全要点：

- **不用 `myrix_migrator` 做 dump。** 它是 `NOBYPASSRLS`，而业务表全部
  `FORCE ROW LEVEL SECURITY`（`packages/platform-store/src/migrations/0001_tenancy.sql`
  等）。`pg_dump` 默认 `row_security=off`：遇到会受行安全策略影响的表时它**直接
  报错并退出**（这是 `pg_dump` 的 fail-closed 行为，**不是**静默出一份"少行但看起来
  完整"的 dump）。换句话说，用迁移角色做 dump 会失败，而不是给你一个不完整备份。
  备份改用**显式超级用户** `myrix_admin`（`BYPASSRLS`）。
  也**绝不**加 `--enable-row-security`：那个开关会让 `pg_dump` 按策略过滤行，
  才真会**静默缺行**——本脚本不使用它。
- **ACL 随可信备份保留（不要加 `--no-privileges`）**：同一次部署生成的 custom 归档
  是可信备份，`pg_dump --format=custom` 会把对象授权（`GRANT`/`REVOKE`）一并写入。
  脚本**故意不加** `--no-privileges`，恢复端也**故意不加**。删掉归档 ACL 会造成
  恢复后权限永久缺失：`renderGrantsSql`（`deploy/vps/init.mjs`）只重放认证 schema
  与组成员关系，`migrate` 登在 `myrix_internal` 里的迁移记录会因"已存在"而跳过，
  因此 migrate/auth/grants **不能**重建全部权限。
- 超级用户口令**只在一次性容器内**从只读的 `secrets/postgres-superuser-password`
  读入 `PGPASSWORD` 环境变量；命令行只出现受控路径与镜像名，因此宿主机
  `ps` 看不到口令，脚本也不打印连接串。
- 绝不为了备份**关闭或削弱 RLS**。
- 任何一步失败（容器非零退出、产物为空、`sha256sum -c` 失败）都会立即退出，
  **不打印"完成"**，也**不写 `SUCCESS`**。
- 卷必须已存在（精确名 `myrix-vps_myrix-cell-1-home`），脚本用
  `docker volume inspect` 先确认；`docker run -v` 不会静默新建空卷。
- 备份完成后请把**整个时间戳目录**复制到 VPS 之外。备份目录本身含全部秘密，
  必须保持 `0700`。

## 3. 恢复前必须满足的条件

恢复是**破坏性**操作，脚本只在下面这种情况下才会继续：

1. 传入的是**单个备份集目录**（含 `sha256sums`），且 `SUCCESS` 存在；
2. `sha256sums` **恰好 4 行**、每行形如 `<64位小写十六进制>  <名字>`，名字只取四份
   固定产物之一且各一次；`sha256sum -c` 全部通过。脚本是**逐行严格解析**：空行、
   注释、第 5 行及以后的额外行、单空格、大写哈希、重复项、以及任何目录外/越界
   路径都在跑 `sha256sum` **之前**被拒绝，绝不让 `sha256sum` 去打开清单里越界的
   文件；
3. 目标项目**已停**（同第 1 节的停服务步骤）；
4. `postgres` 已在运行；
5. 业务库 `myrix` 与 Keycloak 库 `keycloak` **已由 `provision` 建成空库/角色**；
6. Cell 卷 `myrix-vps_myrix-cell-1-home` **存在且为空**。

不满足就**拒绝**——脚本**不创建/不删除/不清空**任何库或卷，**绝不**执行
`docker compose down -v` 或 `docker volume rm`。卷非空时会拒绝，避免把
"恢复"变成"覆盖历史"。

## 4. 恢复的唯一正确顺序

> 关键点：**先在空库上恢复数据，最后才启动应用**。`up` 全套会触发 compose 的
> `depends_on` 链（provision → migrate → auth → grants → bff/gateway/cell/keycloak），
> 其中 `migrate` 会在**空库**上建表。若先 `up` 再恢复，`restore.sh` 的空库检查
> 就会拒绝（这正是我们要的 fail-closed），所以顺序不能颠倒。

`backup.sh` 的 `config.tgz` 里包含 `secrets/` 全部秘密，**恢复脚本不会自动解包**
（避免脚本静默覆盖你当前正在使用的秘密）。请手工、显式地恢复：

```sh
cd deploy/vps

# (0) 停掉本项目除 postgres 之外的容器（postgres 保持运行）。
docker compose -f compose.yml -f ../auth/compose.auth.yml stop bff gateway cell-1 keycloak

# (1) 手工恢复同套私有配置：从 <备份集>/config.tgz 解出 .env secrets auth sql。
#     先停服务，再核对 .env/secrets 与备份集是同一套（同一 commitSha、同一 owner 凭据）。
mkdir -p /tmp/myrix-config-restore && chmod 700 /tmp/myrix-config-restore
tar -xzf /secure/backups/<时间戳>/config.tgz -C /tmp/myrix-config-restore
# 人工比对后再覆盖本目录（覆盖前务必另行留存当前配置）。
cp -a /tmp/myrix-config-restore/. .

# (2) 只用同版本镜像起 postgres + provision，建空库/角色。
#     绝不要 `up` 全套：那会自动跑 migrate，把空库填满，之后 restore 必然拒绝。
docker compose -f compose.yml -f ../auth/compose.auth.yml up -d postgres
docker compose -f compose.yml -f ../auth/compose.auth.yml run --rm provision

# (3) 在空库/空卷上恢复数据（本脚本会再次校验 SUCCESS 与全部 SHA-256）。
#     脚本成功后的收尾提示只列 (4)(5)：**不要重跑** restore.sh，也不要再跑
#     provision——此时库和卷都已非空，重跑必然被拒绝。
sh restore.sh /secure/backups/<时间戳>

# (4) 迁移与授权：migrate -> auth -> grants（顺序固定，不可交换）。
docker compose -f compose.yml -f ../auth/compose.auth.yml run --rm migrate
docker compose -f compose.yml -f ../auth/compose.auth.yml run --rm auth
docker compose -f compose.yml -f ../auth/compose.auth.yml run --rm grants

# (5) 最后启动应用（bff/gateway/cell-1/keycloak），等健康检查通过。
docker compose -f compose.yml -f ../auth/compose.auth.yml up -d --wait
```

### 4.1 为什么是 `migrate → auth → grants` 而不是别的顺序

- `migrate`（业务库 + 网关账本）：要求库 owner 是 `myrix_migrator`，建表；
  已存在的表与已登记的迁移会跳过（幂等）。
- `auth`：建 `myrix_auth` schema（`sessions`/`flows`/`subjects`）；
- `grants`：在最末做**低权授权收口**——把 schema/表权限授给 `myrix_bff` /
  `myrix_auth` / `myrix_gateway`，并登记 Cell 凭据摘要与 owner 主体。

顺序反了（例如先 grants）会因为表还不存在而失败。但要明确：**这三个 job 不是 ACL 的
完整重建途径**。对象 ACL 由可信备份的归档带回（见下节）；`grants` 只是幂等收口，
`renderGrantsSql` 仅覆盖 `myrix_auth` 与组成员关系，`migrate` 记录会跳过，因此它
**补不回**归档里被丢弃的授权。

### 4.2 对象 owner 与 ACL（脚本已处理，勿手改）

`restore.sh` 用显式超级用户连接，并用
`pg_restore --no-owner --role=<owner>` 指定归属：

- 业务库 → `myrix_migrator`（库 owner；低权运行角色不是 owner）；
- Keycloak 库 → `keycloak`（`deploy/auth/auth-config.ts` 的 `keycloakDbUser`
  默认值，也是 `KC_DB_USERNAME`）。

为什么只保留 `--no-owner`、**去掉** `--no-privileges`：custom 归档里**带着 dump 时的
owner 与 ACL**，仅给 `--role` 并不等于忽略 archive owner，所以恢复端必须用
`--no-owner` 让对象归到 `SET ROLE` 后的 `--role`。而 ACL **必须保留**——它对应用能否
读写业务表/认证表是必需的，且**没有**其它可靠重建路径：`renderGrantsSql` 只管认证
schema 与成员关系，业务/网关授权不在其中，而 `migrate` 因迁移已登记会整段跳过。
所以备份侧的 `pg_dump` 与恢复侧的 `pg_restore` **都不加** `--no-privileges`。
备份侧的 `pg_dump --no-owner` 对 custom 归档**不起决定作用**（归档仍记录 owner），
它只是与 plain-SQL 语义保持一致；不要以为"dump 带了 `--no-owner`，恢复端就可以省掉
`--no-owner`"。

**前提：恢复前必须 provision 出全部原始角色。** 归档里的 `GRANT` 会引用
`myrix_app`、`myrix_gateway_app`、`myrix_bff`、`myrix_auth`、`myrix_gateway`、
`myrix_migrator` 等角色；缺任一角色时 `pg_restore` 会**失败退出**（fail-closed），
而不是静默跳过授权。因此第 4 节的 `provision` 步骤不可省略。

如果 Keycloak 库误让表归 `myrix_admin`，应用角色连上就**没有表权限**——这正是要
避免的。

### 4.3 旧备份（`--no-privileges` 生成）的遗留风险

**在本修正之前**，用旧脚本生成的 `<时间戳>` 备份集其 `myrix.dump`/`keycloak.dump`
**不含任何 ACL**。这类备份集可以恢复数据，但：

- 恢复后**可能缺少权限**，且 `migrate → auth → grants` **无法补全**所有授权
  （认证 schema 之外的对象尤其如此）；
- 必须由人工**显式审查并重新授权**（对照当前部署的 `\dp`/`\z` 或迁移文件手工核对），
  **绝不要**把这类旧备份的恢复称为"完整恢复"；
- 优先用**本修正之后**重新生成的备份集，它按设计保留 ACL，可恢复出与备份时一致的
  授权。

## 5. 恢复后自检

```sh
cd deploy/vps
docker compose -f compose.yml -f ../auth/compose.auth.yml ps   # 全部 healthy
# 业务库表数、Keycloak 表数应非零：
docker compose -f compose.yml -f ../auth/compose.auth.yml exec postgres \
  psql -U myrix_admin -d myrix -c '\dt' | head
```

再核对：

- 对象权限已随归档恢复：用 `\dp`（或 `\z`）抽查业务表/认证表对
  `myrix_bff`/`myrix_auth`/`myrix_gateway` 的授权是否与备份时一致；若用的是旧
  `--no-privileges` 备份，这里必须人工重新授权（见 4.3）；
- `secrets/bff.env` 的 `MYRIX_RUNTIME_SIGNING_KID` 与 `secrets/cell-1.env` 的
  `MYRIX_GRANT_JWKS` 是否仍配对（不配对则 Cell 校验签名失败）；
- `auth/realm-myrix.json` 里 owner 的 `id` 与 `sql/30_identity.sql` 登记的
  subject 是否一致；
- 用真实浏览器完成一次 owner 登录（数据库能起来不代表登录链路通）。

## 6. 明确不支持 / 边界

- **不**支持按文件挑选恢复（例如只恢复 `keycloak.dump`）：四份产物必须成套。
- **不**支持把旧备份合并进已有数据；目标库/卷非空一律拒绝。
- **不**提供 `--force` / 跳过校验的开关。
- **不**在容器里跑 `docker`（脚本跑在宿主机，直接调宿主 docker CLI）。
- **不**做远程备份上传/加密：请自行把备份集复制到 VPS 之外并加密保存。

### 6.1 实测范围与剩余边界（不要扩大验收结论）

2026-10-01，Lead 另行运行了**真实、一次性、隔离的 PostgreSQL 17.11 容器夹具**，
使用部署所固定的官方镜像摘要；不连接本地开发库或 VPS，不构建 Myrix 镜像。
执行仓库真实的 provision SQL、12 个业务迁移、网关迁移、认证迁移与低权限 grants/身份登记，然后备份并恢复到两个新建空库：

- 业务库 **20 张表**的行数、对象 owner，以及 BFF/auth/gateway 等角色的逐表有效权限一致；
  相关函数的执行权限也逐项一致。原始角色预先存在。
- 恢复使用 `pg_restore --exit-on-error --no-owner --role=<owner>`，**保留 ACL**。
  `FORCE RLS` 没有阻止该夹具的装载；恢复后迁移全部跳过，BFF 的低权限真实 LOGIN
  仍可在租户上下文中读取原有租户。另行确认非 BYPASSRLS 迁移角色的默认 dump 会失败。
- 第二库用 `keycloak` owner 的一张标记表验证独立库恢复，**不是完整 Keycloak realm/用户恢复**。
- 真实 Docker bind mount 上验证了容器 root 生成的 dump 在 `chmod 600`、
  `chown "$(stat -c '%u:%g' /out)"` 后由宿主用户拥有且可读。
- 本地忽略目录中的[结构化报告](<../../data/validation/pg-recovery-lN3PMV/report.json>)记录此次结果；不随源码分发。

上述夹具不替代完整脚本/现场演练：

- 两个脚本的完整编排仍只有 **34 条 mock/命令契约回归**；尚未实测整套
  `backup.sh → restore.sh`、真实 Cell 卷归档，以及完整 Keycloak realm 的联合恢复。
- 未实测缺失原始角色的恢复失败情形；必须保留全部角色前置条件及 `--exit-on-error`。
- 尚未在目标 Ubuntu VPS 上确认数字属主与 bind mount 行为；不能由本地 Docker 结果
  推导所有宿主文件系统均相同。现场恢复后仍必须核对行数、关键行与实际 LOGIN 权限。
- **OUT 目录安全检查**是尽力而为，不防恶意 root，也不防同一 UID 的并发竞态。
