---
name: myrix-development
description: 在 Myrix 中实现、调试和评审代码；用于模块定位、安全约束、测试分层、DSH 集成以及同步文档。
---

# Myrix 开发

## 开始前

阅读根 [AGENTS.md](../../../AGENTS.md)、[本地开发](../../../docs/implementation/local-development.md)、[架构](../../../docs/architecture.md)、[运行时依赖](../../../docs/development/runtime-dependencies.md) 和 [验证指南](../../../docs/testing/acceptance.md)。先检查工作区状态，不覆盖他人修改，不提交运行数据或维护者部署资料。

## 工作路径

1. 区分当前链路与 legacy：当前 UI 在 `apps/novel-web`，BFF 装配作品路由及存储；`apps/works-service` 是尚未统一的另一实现，不能仅因名字而改错入口。console/control-plane/dsh-shim 是历史链路。
2. 定位契约、判定、存储、HTTP 与插件边界。contracts/novel-protocol 保持纯契约；governance/registry 禁止 I/O 与隐式时钟；platform-store 保持事务、CAS、FORCE RLS 和低权 LOGIN。
3. 改身份/授权/审计先列拒绝案例并同步 ADR：跨租户、同租户非属主、缺角色、策略缺失、撤权、重复命令、过期租约、版本冲突。obligations 只能收窄，不能增加授权。
4. 不修改只读 vendor。需要 DSH 扩展时先用当前 Harness Inspect 查询精确 Service/Event/Config/Tool/Slot 契约，再改自有 Cordis 插件/bundle。源码 submodule 和 npm CLI 是独立锁定产物，同版本不证明字节相同。
5. 模型只用已实现的 Responses 链路；禁止 `chat/completions` 兼容、转换、失败回退。不得扩大 Cell 白名单，也不把这个开发 skill 装入 Cell。
6. 显式初始化专用本地 PostgreSQL，`pnpm dev` 不迁移/重置。真实凭据仅存被忽略文件且权限 0600。需要 Web 重建时先停止使用相同产物的开发栈。
7. 小范围实现 + 回归，再执行下方门禁。变更业务行为时同步业务/实现/验收文档，不堆积第二份规范。

## 门禁与交付

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:ci
pnpm build:web
```

数据库测试跳过必须报告；按验证指南额外运行真实低权 PostgreSQL、DSH smoke、浏览器或 Go 检查。调用真实模型会计费，须获得授权；线上部署、重启、迁移、凭据轮换也须单独确认操作范围。

交付列出改动、实际执行的命令/结果/跳过项、未验证边界、文档链接和剩余风险。历史测试数量与本地 fixture 不能替代本次或线上证据。
