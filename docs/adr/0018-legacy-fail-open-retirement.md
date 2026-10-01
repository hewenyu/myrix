# ADR-0018：移除旧治理客户端的网络故障放行

状态：已接受。

首版使用真实 DSH Principal/PEP 与服务端绑定，不把旧 dsh-shim 治理插件作为兼容运行时。旧演示代码保留供迁移参考，但也不能保留网络故障放行路径。

旧 PolicyClient 的 `failClosed: false` 会把 PDP 异常转换成 allow，违反仓库硬规则。现将失败结果固定为 deny，使用 `policyRevision: "unavailable"` 和 `matched: "default-deny"` 明示原因。该配置字段只保留类型兼容，false 不再具有放行效果；默认、true、false 均有回归测试。

这不是对旧 shim 插件作生产安全背书。旧客户端缓存与旧异步工具 hook 不替代 v1 的同步执行 guard；新 myrix-base 不装载旧治理插件。旧管理台也不能冒充新平台认证入口。
