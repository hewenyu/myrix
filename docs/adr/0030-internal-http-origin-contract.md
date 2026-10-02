# ADR 0030：同机内部 HTTP origin 契约（入口 → 工厂 → 插件的一致收敛）

- 状态：已采用（实现与跨层测试见相应 PR；本 ADR 不是上线成功证明）
- 日期：2026-10-01
- 相关：ADR-0019（Cell 绑定租约）、ADR-0023（Responses 网关）、ADR-0029（首版单台 VPS、同机 OIDC 与容器凭据边界）
- 实现：`deploy/images/cell-entry.mjs`、`tests/poc/lib/cell-profile.mjs`、`plugins/myrix-binding-lease/src/config.ts`、`plugins/myrix-llm-gateway/src/config.ts`

## 背景

ADR-0029 决策 5 允许单机 VPS 部署通过 `MYRIX_CELL_INTERNAL_HTTP_ORIGINS` **逐项声明**同机 Docker Compose 服务
origin（例如 `["http://bff:8791","http://gateway:8790"]`），使 Cell 能在明文内网里访问 BFF/works 与模型网关。

容器入口（`cell-entry.mjs`）已经实现了这套声明校验，并把 `http://bff:8791` / `http://gateway:8790` 判定为合法
`.worksOrigin` / `.gatewayURL`。但**下游两个插件仍各自独立地拒绝一切非回环明文 HTTP**：

| 层 | 文件 | 非回环明文 HTTP 的行为 |
|---|---|---|
| 容器入口 | `deploy/images/cell-entry.mjs` | 声明后放行 |
| 工厂 | `tests/poc/lib/cell-profile.mjs` | 不校验，原样写入 profile |
| 绑定租约 | `plugins/myrix-binding-lease/src/config.ts` | **启动即失败** |
| 模型网关 | `plugins/myrix-llm-gateway/src/config.ts` | **启动即失败** |

真实启动时的后果是一条**静默的死锁链**：Cell 进程起得来，但 `myrix-binding-lease` 因 origin 校验失败而
不激活 → `principals` 永远没有活性生产者 → driver 的 `create` 以 `403 identity_invalid` 拒绝 →
BFF 对仍处于 `creating` 的绑定请求恢复，被 `binding-not-active` 拒绝后延后原命令，并退还尝试预算。
原 `create` 因而一直排队、`attempts` 保持 0；这不是观察到了无限新增恢复命令。模型网关插件同时也不激活。
容器健康和创建接口的 201 都不能证明会话已激活，更不能证明模型链路可用。

根本问题是**声明没有贯穿入口、工厂与两个插件**：入口有了显式例外，工厂没有转交该声明，插件没有对应配置。

## 决策

1. **引入一个可选的 `internalHttpOrigins: string[]` 配置字段，语义在入口、工厂与两个插件之间逐字对齐。**
   顶层配置（`cordis.patch.yml` 的 `config:`）在 `myrix-binding-lease` 与 `myrix-llm-gateway` 上新增该字段；
   容器入口把已校验的声明原样（JSON）传给工厂，工厂把它写进两个插件行的 `!!js` 表达式。

2. **默认 fail-closed：空列表/不配置 = 只允许 HTTPS 与显式回环 HTTP。**
   例外必须显式声明，绝不存在"内网就宽松"或"明文总开关"。回环（`127.0.0.1` / `[::1]` / `localhost`）
   与 HTTPS 的老行为完全不变。

3. **精确 origin + 端口匹配。** 声明项是集合成员判定（`url.origin === raw` 且 `includes`），
   声明 `http://bff:8791` **不等于**放行 `http://bff:8792`、`http://bff`（默认端口）、`http://evil.example:8791`
   或任何 IP/通配符。声明的是 origin，不是主机。

4. **入口与两个插件都校验整份声明，且未使用的非法项也必须拒绝。** 即使某项与本次 `origin`/`baseURL` 无关，
   非法项也要在**启动时**失败。工厂只检查字符串数组的传输形态并原样转交，不充当 URL 放行的判定层；
   它不会把错误类型静默替换成空列表。插件必须独立校验，不能因为输入来自工厂而省略检查。

5. **声明项的校验规则（入口与两个插件一致）**：环境变量为 JSON 字符串数组，插件配置为字符串数组（最多 16 项）；
   每一项是**规范 HTTP origin**——`http://`、`url.origin === raw`、主机为**单标签 Docker 服务名**
   （`^[a-z][a-z0-9-]{0,62}$`）。以下全部拒绝：通配符（`http://*:1`、`http://*.bff:1`）、
   内嵌凭据（`user:pass@`）、路径（含结尾 `/`）、查询串、fragment、非 HTTP 协议（`https:`/`ftp:` 等）、
   多标签域名、IPv4/IPv6 地址。**错误信息不回显原始值**，避免把可能内嵌的凭据写进日志。

6. **入口解析器的语义与插件对齐。** `parseInternalHttpOrigins` 与两插件新增的
   `normalizeInternalHttpOrigin` / `resolveInternalHttpOrigins` 使用同一条规则；入口只做一次，
   插件再做一次是刻意的纵深防御，不是重复劳动。

7. **不放宽任何既有安全属性。** 重定向仍然被拒绝；模型链路仍然是 **Responses-only**，
   `chat/completions` 与完整 `/responses` 端点配置仍然启动即失败；凭据、路径、查询串检查不变。
   本决策只改变"明文 HTTP 的传输层是否被显式声明为可信"，不改变任何授权判定。

## 适用范围与边界

- **仅用于单台宿主上的受信 Docker bridge 网络**：声明只能使用单标签服务名。
  语法校验不是 DNS 或实际路由的证明；部署者仍须确保声明指向本 Compose 网络内的受控服务，
  不得配置跨主机解析、外部别名或代理。这里没有声称单标签名称天然不可能解析到外部地址。
- **不是通用的明文旁路**：跨主机通信、公网域名、IP、通配符一律不接受；跨主机部署必须重新设计传输加密
  （见 ADR-0029 决策 5）。
- **不关闭任何业务鉴权**：声明只影响 URL 是否被接受；`Authorization`、短期签名 grant、租户绑定、
  绑定租约活性与策略快照仍然逐项校验。信任边界是"同机 Docker 网络"，不是"已认证"。
- **明文承载 Cell 令牌的风险被显式接受**：这正是为什么例外必须逐项声明、默认关闭，并且
  在 ADR-0029 里已经被记录为单机部署的既有取舍。

## 备选方案

- **只在入口放行、插件保持严格**（本次回归之前的实际状态）：被否决，因为入口与插件各自持有一份
  信任判定，语义必然继续漂移，故障表现为无关的 `identity_invalid`。
- **给插件一个 `allowInsecureHttp: true` 布尔开关**：被否决。布尔开关会一次性放行任意明文主机，
  无法约束"只允许这两个同机服务"，正是 ADR-0029 明确拒绝的"blanket insecure-HTTP flag"。
- **让插件读取 `MYRIX_CELL_INTERNAL_HTTP_ORIGINS` 环境变量**：被否决。插件是 DSH 侧的 PEP，
  应当只从 `cordis.yml` 的 Config 取值（AGENTS.md 目录职责）；环境变量是入口/部署层的输入。
- **公网 IP 也允许声明**：被否决，无法与"同机 Compose 服务"区分，等于开放任意明文端点。

## 配套恢复与验收边界

本次同时收窄 [ADR 0028 的会话恢复](0028-runtime-session-recovery.md)：

- 只有 `send` / `cancel` 可以触发打开状态预检和反应式恢复；`create` / `resume` 本身就是打开动作，不能再次递归恢复。
- 打开命令遭到明确的身份或授权拒绝时，按既有失败分类结算；网络、429、5xx 等可重试失败按既有预算退避，达到上限后终止。
  不放宽授权，不伪造绑定 `active`，也不再通过恢复延后持续退还这些命令的尝试预算。
- 生产无模型冒烟在拿到 201 后立即记录真实会话 ID，再通过有界的认证查询等待**该 ID** 为 `active`，之后才撤销。
  超时、撤销、未知状态或另一个活跃会话都不算通过。冒烟仍不发送模型消息。
- 这些回归不代替上线后真实模型、工具、持久终态和备份重启验证；当前 ADR 不声明生产验收完成。

## 验证要求

- 单元：两个插件分别拒绝通配符、凭据、路径、查询串、fragment、非 HTTP 协议、多标签域名与 IP；
  未配置时非回环明文仍拒绝；回环与 HTTPS 不变；错误信息不含原始凭据。
- **跨层（权威）**：用真实 loader 语义（`!!js` → 表达式求值）从**工厂生成的 profile** 中取出
  `myrix-binding-lease` / `myrix-llm-gateway` 的 `config`，直接喂给插件**真实的 `resolveConfig`**，
  断言 `["http://bff:8791","http://gateway:8790"]` 被接受；缺失声明与端口不匹配的声明被拒绝。
  这条测试不允许退化成对 YAML 文本的字符串匹配。
- 容器：入口对声明做全量校验（含未使用项）、去重后原样传给工厂与子进程环境；
  entry → factory → 子进程环境的链路走通。
- 类型检查与既有回归（绑定租约、模型网关、容器入口、工厂）全部通过。
