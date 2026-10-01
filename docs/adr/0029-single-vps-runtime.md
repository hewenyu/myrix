# ADR 0029 — 首版单台 VPS、同机 OIDC 与容器凭据边界

- 状态：Accepted（实现和部署验证见相应 PR / GitHub Actions；本 ADR 本身不是上线成功证明）
- 日期：2026-10-01

## 背景

首版实际部署目标是单台 VPS，不是 Kubernetes。用户已有 Nginx、域名与证书，但没有外部 OIDC 服务。不能为降低部署门槛而把开发登录开放到公网，也不能把多个租户放进同一个 DSH 进程或历史目录。

## 决策

1. Docker Compose 装配 BFF（同时提供已构建前端和 works）、模型网关、独立 Cell、PostgreSQL 与同机 Keycloak。宿主机已有 Nginx 终结 HTTPS；不另外部署 Caddy，不依赖 Cell Manager / Kubernetes。Kubernetes 实现仅保留为后续可选部署能力。
2. Keycloak 只是标准 OIDC 身份提供方。BFF 继续执行原有 issuer/sub 身份映射、租户成员、owner、session binding、grant 和 RLS 检查；不新增免认证路径或管理员授权旁路。首版初始化只支持一个 Cell、一个租户和一个显式 owner；Keycloak 用户 UUID 与预置的 OIDC subject 一致。BFF 只查询既有 issuer/sub 映射，未知 subject 不自动注册、不获得默认成员身份。关闭公开注册和密码直连授权，不导入开发身份；初始临时密码必须经标准登录流程更换。
3. BFF 与 Keycloak 的宿主端口仅绑定回环地址，Nginx 反代公开浏览器入口及 OIDC 登录路径。Keycloak 管理入口不经公网反代开放。保留已有站点的证书、安全访问限制和去除 query 的访问日志；上线前备份配置并通过 `nginx -t`，不修改其他站点。
4. 同机 Docker 网络是明确的传输信任边界，不等于授权。内部 BFF/works、gateway、Cell 通信仍要求各自的服务凭据、短期签名 grant、租户绑定和策略校验。数据库、网关与 Cell 不发布公网端口。
5. Cell 默认拒绝非回环 HTTP。单机部署可通过 `MYRIX_CELL_INTERNAL_HTTP_ORIGINS` **逐项声明精确 origin**，例如 `["http://bff:8791","http://gateway:8790"]`。声明仅接受规范 HTTP origin 和单标签 Docker 服务名；不接受公网域名、IP、通配符、用户名/密码、路径、query 或 fragment。声明端口不匹配仍拒绝。此例外不改变对外 HTTPS 要求，不关闭任何业务鉴权；跨主机部署必须重新设计传输加密。
6. Cell 通过已有合法 profile 工厂生成配置，不手工注册另一套插件。仅接收自己的 tenant/cell ID、公开验证 JWK、works/gateway/admin 凭据和模型目录；数据库连接、OIDC 密钥、上游模型密钥、签名私钥、模块注入环境不能进入 Cell。每个 Cell 使用独立持久卷，重启保留 JSONL 与 session cursor。
7. PostgreSQL 超级用户只用于明确的初始化和停机备份/恢复操作，不交给应用。FORCE RLS 下不能用 NOBYPASSRLS 迁移角色做完整导出，也不能为了备份关闭 RLS。业务、认证、网关、Keycloak 与迁移使用不同角色；常驻业务服务不得使用 owner/superuser/BYPASSRLS。Keycloak 的数据库与角色和 Myrix 业务域分离。迁移显式执行，不能自动导入开发 seed。
8. 生成的凭据、realm 初始密码、私钥与部署状态只能进入私有部署目录（文件 0600、新建目录 0700）；不进入 Git、Docker context、构建参数、镜像层、PR 或 CI 日志。生产初始密码通过受控文件交付，不在日志中打印。初始化先检查全部输出路径，拒绝 symlink、覆盖与 --force；升级不能重新生成身份。私有 SQL 作业和 Keycloak 用 UID/GID 1000 读取对应的 0600 输入，不增加 DAC 绕过能力或改成全局可读。
   BFF 通过公共 DNS/HTTPS 访问规范 issuer，不添加 host-gateway 解析覆盖、不为此全局放行 Docker 来源。
9. 交付顺序固定为：feature 分支 → PR 检查 → 合并主分支 → GitHub Actions 无缓存双架构构建/发布 → 校验发布结果 → VPS 拉取同一提交对应的不可变镜像再部署。禁止用本地构建替代正式发布。

## 验证要求

- Cell 缺失凭据、非法 origin、未声明 HTTP、端口不匹配、平台秘密误注入均拒绝；合法同机 origin 显式通过。
- 默认 Compose 不公开数据库、网关、Cell 或 OIDC 管理端口；验证内部网络互通和只读根文件系统下的可写卷。
- 真实 OIDC 登录、回调、首次密码变更、初始主体映射与工作台授权要在部署后验证，不能只凭静态配置测试宣称成功。
- 双架构镜像索引必须同时含 `linux/amd64` 和 `linux/arm64`，无缓存构建与发布凭据作用域由 CI 回归约束。
- 备份覆盖 PostgreSQL（含 Keycloak 状态）、每个 Cell 的历史卷及必要私有配置；恢复和升级不得悄悄删除历史或重置身份。

## 边界

单机部署不能提供节点级高可用。宿主机 root / Docker 管理员可读取容器秘密和持久卷；本决策不声称防御已失陷的宿主机。初版静态 Cell placement 的扩租、身份绑定与凭据轮换是显式运维操作，不等同于自动租户编排平台。
