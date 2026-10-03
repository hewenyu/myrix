# novel-web：小说工作台

React + Vite + TanStack Query + Tiptap 的三栏工作台：作品列表；大纲、章节/历史版本、设定圣经；助手与会话管理。组件测试与浏览器验收是两层不同证据：jsdom 测试不能当浏览器验收，本地浏览器跑过的历史记录也不保证当前提交，解读方式见 [验证方法](../testing/acceptance.md)。

## 接口与运行

- 浏览器只请求同源 `/api/v1`，路径对应 [BFF API](./bff-api.md)。不直连 DSH、不传 `tenantId/userId/actor` 身份字段；凭据只用 HttpOnly session cookie。
- 写入使用 `GET /auth/session` 返回的 CSRF token，不落 localStorage。认证模式由公开 `/auth/config` 决定；仅开发模式显示固定种子登录名，生产显示 OIDC 跳转。
- 推荐由 BFF 同源托管前端构建产物。Vite 的 API proxy 仅用于显式配置的开发联调；BFF 的 `MYRIX_ORIGIN` 必须与浏览器实际 origin 完全一致，不能用代理规避 Origin/CSRF 校验。
- 依赖清单见 [前端 package.json](../../apps/novel-web/package.json)；根 [package.json](../../package.json) 已把前端独立 typecheck/test 纳入 `pnpm typecheck` 与 `pnpm test`。无需调整根 TypeScript JSX 配置。

```bash
pnpm --filter @myrix/novel-web typecheck
pnpm --filter @myrix/novel-web test
pnpm --filter @myrix/novel-web build
```

## 数据与冲突

- 业务值始终是纯文本。Tiptap 使用段落 JSON 文档载入、按单换行导出，禁用富文本格式节点，保留连续空格、空行与行首尾空格。不要重新使用 HTML 字符串装载正文，否则 HTML 解析器会改变空白。
- 没有 `dangerouslySetInnerHTML`；模型/工具输出由 React 文本节点展示，HTML 样本按文字显示。
- 保存始终携带 `expectedVersion`。409 保留本地草稿，提供重新读取、显式采用服务端内容、以最新版本提交草稿三种动作，不静默覆盖。
- 队列回执明确标注“已入队，等待服务端确认”，不把 202 当作模型回复或内容已经落库。

## 流式事件：持久与瞬态分开

实现见 [chatReducer.ts](../../apps/novel-web/src/state/chatReducer.ts) 和 [useSessionStream.ts](../../apps/novel-web/src/state/useSessionStream.ts)。

1. 持久 `seq` 按单调水位去重，而非要求连续。DSH 恢复与内部事件过滤可产生合法跳跃；不枚举所有“缺号”，旧事件也不能因窗口淘汰而重新出现。
2. 只有服务端明确发出 `replay-required` 才要求补放，不由编号跳跃推断丢失。
3. `delta` 仅供临时显示。**只有持久 `assistant` 事件确认最终回复**；它替换瞬态片段，而非再追加一份。
4. 新 attempt 的 `stream-start` 先丢弃旧 attempt 未提交片段，避免重试输出前缀拼接；`stream-abandoned`、`error`、`turn-end` 和断线同样清除未确认片段。
5. 上述清理保留已持久回复及本地待回显用户消息。断线不是完成；UI 显示错误/重连状态，并指数退避重连。
6. 切换会话立即关闭旧 EventSource。取消提交成功只是命令已接受，状态仍以服务端事件为准。

## 验证

[前端测试目录](../../apps/novel-web/tests/) 覆盖：

- HTTP：cookie/CSRF、不发送身份头、401/409/503 分类、Retry-After 与网络错误。
- reducer：持久水位/大跨度跳跃/迟到去重、delta/final、重试开始/废弃/错误/断线边界、本地消息回显与明确截断标记。
- 草稿：CAS 冲突、失败保留、明确覆盖与重提，不静默丢弃。
- 编辑器：纯文本往返、空白保留、HTML 样本不注入、只读与外部同步。
- 面板：登录模式、冲突动作、状态、取消、流式未落定标注与断线提示。

命令见上文"接口与运行"。组件测试的具体数量随代码演进变化，不作为当前版本可用的证明；
浏览器与模型闭环见 [验证方法](../testing/acceptance.md) 的"浏览器与模型闭环"。jsdom 固定在 `^29.1.1`
以兼容当前 Node 24.13 基线（见[前端 package.json](../../apps/novel-web/package.json)）。

## 不构成保证的部分

- 真实浏览器与实际 BFF/Cell/模型网关的完整登录、生成、保存、撤权链：按
  [验证方法](../testing/acceptance.md)显式 opt-in 运行并独立读取业务数据确认，历史本地通过记录不保证当前提交。
- ≥20 万字单文档编辑性能；当前全量加载/替换。
- 编辑器代码分割和大包加载优化。
- 外部 OIDC 身份提供方及真实模型凭据。
