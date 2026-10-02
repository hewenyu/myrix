# ADR 0032：BFF driver 事件流的"建立截止时间"与流生命周期

- 状态：已采用（实现与回归测试见相应 PR；本 ADR 不是上线成功证明）
- 日期：2026-10-01
- 相关：ADR-0016（runtime driver 契约）、ADR-0019（Cell 绑定租约）、ADR-0022（运行时回执）、ADR-0028（会话恢复）
- 实现：`apps/bff/src/runtime-driver-client.ts`
- 测试：`apps/bff/tests/runtime-driver-stream-lifecycle.test.ts`（真实 `node:http` + 真实 undici）
- 不在本决策范围内：`apps/bff/src/runtime-stream.ts` 的白名单投影、`runtime-router.ts` 的持续复核/撤权

## 背景

线上表现为浏览器侧 SSE 在大约 10 秒后必然断流。前端拿到的不是业务事件，而是
`stream-interrupted`（`runtime-router.ts` 的 `projectStream` 在迭代器抛错且调用方未 abort 时
补发的 status 帧）。

根因在 BFF 的 driver HTTP 客户端 `streamEvents`：

1. `withDeadline()` 每次都**无条件**启动一个 `setTimeout`（缺省 `DEFAULT_DEADLINE_MS = 10_000`），
   到期即 `controller.abort(...)`。这个合并信号同时被用作 `fetch` 的 signal。
2. 代码注释（旧第 455-457 行）声明"截止时间只覆盖建立连接 + 收到首个响应头"，但实现里
   收到 `response.ok` 之后**从不清除该定时器**：`handle.dispose()` 只在迭代器的 `finally`
   里调用，而迭代器会活到会话结束。于是定时器在响应头之后仍然 armed。
3. 结果：任何 SSE（空闲的与活跃的都一样）在 10 秒时被自己人 abort。挂起的 `reader.read()`
   以 `AbortError` 拒绝 → `projectStream` catch → 发 `stream-interrupted` → 浏览器断流。
4. 用真实 HTTP 复现：`deadlineMs: 400` 的客户端在约 300-400ms 时抛 `AbortError`（kind=timeout），
   此前只收到 3 帧。

同时暴露出第二个（更隐蔽的）缺陷：`sseFrames` 提前结束时，旧实现只调用
`await body.cancel()`。当 `sseFrames` 已经 `body.getReader()` 持有锁时，`body.cancel()`
会因流被锁定而**拒绝**（被 `catch` 静默吞掉），上游连接根本没有释放。真正生效的取消必须是
持有锁的 `reader.cancel()`。这一点与"建立截止时间"缺陷耦合：过去定时器总会触发，
把挂起的读取"救"出来，所以这个问题没有暴露；一旦按注释语义停掉定时器，空闲会话上的
`return()`/撤权就会永久挂住。

第三个缺陷在"停掉定时器 + 用取消信号桥接生成器"之后才浮现：`sseFrames` 是**惰性**
异步生成器，函数体要等到第一次 `next()` 才运行（未启动时 `throw()` 直接拒绝，不执行函数体）。若调用方在迭代器启动之前就
`return()`（或父级 signal 在该窗口 abort），生成器既没有 `getReader()`，也没有注册
`cancelSignal` 的处理 —— 此时"取消信号"没有任何接收方，`body` 从未被取消。`return()`
会立刻返回 `done`，但 HTTP 响应体与连接**永远挂着**；由于建立阶段的 deadline 已被
`established()` 停掉，也没有第二个东西会来收尾。用假 fetch 的
`new ReadableStream({ cancel() { cancelled++ } })` 可直接复现：`await streamEvents(...)`、
拿到迭代器后 `await it.return()`，`cancelled` 仍然是 0。

已排除的外部因素：Nginx 侧关闭了 `proxy_buffering`、`proxy_read_timeout` 为 1 小时，
BFF/gateway/Cell 健康检查全部正常；断流时间与 BFF 客户端的 10s 缺省截止时间吻合。

## 决策

1. **截止时间只覆盖建立阶段，并且"收到有效响应头"是唯一的停止点。**
   `withDeadline()` 新增 `established()`：只清除定时器，不做其它事。`streamEvents` 在
   `response.ok === true` 且 `response.body` 存在之后立刻调用它。此后会话空闲多久都不会
   被建立截止时间掐断。

2. **调用方 `AbortSignal` 的桥接贯穿流的整个生命周期。**
   `established()` **只**停定时器，绝不移除调用方 signal 的监听器；撤权、浏览器断开、
   进程关闭必须仍能立即中止已经建立的流。允许"建立阶段与流阶段共用一个合并 signal"，
   但停止的只能是定时器这一半。

3. **abort 之后挂起的读取必须被主动结束。**
   流的生命周期由 `AbortSignal` 桥接到 `sseFrames`：abort 时由持有 reader 锁的一方
   `reader.cancel()`（不是无效的 `body.cancel()`），让挂起的 `read()` 立即以结束收敛。
   取消后不再交付一半的尾部帧。

4. **资源恰好释放一次，且对有界等待负责。**
   `streamEvents` 返回的迭代器由显式对象实现：`next()` 在 done/抛错时清理，
   `return()` **先同步取消再收尾**（否则空闲会话上的 `return()` 会一直挂在永不落定的 read 上），
   `throw()` 同理。`dispose` 幂等：停定时器、摘掉父 signal 监听、取消上游。
   取消路径按生成器是否**已启动**分流，保证任何时刻都恰好有一个有效的取消动作：

   * **未启动**（第一次 `next()` 之前）：生成器函数体没有跑、也没有 reader，
     由 `streamEvents` 自己 `cancel()` 那个尚未加锁的 `body`；已启动后不再重复调用。
   * **已启动**：body 已被 `sseFrames` 的 reader 锁定，`body.cancel()` 无效，
     由 `sseFrames.onCancel` 的 `reader.cancel()` 负责（它能让挂起的 `read()` 立即以结束收敛）。
   * 未启动的 `return()` / `throw()` 直接收敛（`{done:true}` / 以原错误拒绝），
     不去驱动一个从未运行的生成器；父 signal 监听器在两种情况下都被摘掉。

5. **建立阶段的失败判定不能被"迟到的 fetch 响应"绕过。**
   deadline 或父级 signal 触发 abort 之后，`fetch` 仍可能在之后（undici 的 abort 是异步的）
   把响应交回来。此时 deadline 已经失效，把它当"建立成功"返回会给调用方一条立刻结束的
   流，却表现得像一次正常订阅。因此拿到响应后若 `fired() !== undefined`，立即取消该响应体
   并按 `abortOutcome`（`timeout` / `aborted`）返回，绝不返回 `ok: true`。

6. **fail-closed 的竞态语义保持不变。**
   建立阶段仍然会因"响应头到达前超时"或"调用方 abort"失败；
   先到先得（先 abort 记 `aborted`，先超时记 `timeout`），后来的触发不覆盖前者。
   流阶段的 abort 不改变"流已经成功建立"这个返回结果，只结束迭代。

7. **非流式请求的截止时间语义完全不变。**
   `ready` / `postCommand` / `getReceipt` / `revoke` 仍是"请求级 deadline"，
   超时即 `kind: "timeout"`。本决策只改事件流。

8. **不放宽任何授权/租约属性。**
   不新增流级别的最大存活时间（不覆盖流的长短），不因为"已经建立"就跳过任何检查。
   持续授权（bindings/lease/member/work/revision 的周期性复核、撤权即断）仍然在
   router 层负责，本层只负责"建立信号与生命周期"，不承担策略判定。

9. **投影层只有"已完成"才产成功终态。**
   本决策不改投影规则：`turn/end` 只有 `reason.kind === 'completed'` 是成功 `turn-end`，
   其余（含未知/缺失 kind）一律 fail-closed 成固定文案的失败/中断帧；
   授权撤销导致的流结束（`aborted`）也**不**投影成"完成"。生命周期修复不得顺势
   放宽这条判定，也不得让"提前结束"看起来像一次正常收尾。

10. **测试必须用真实 HTTP 与真实 undici，且用有界等待。**
    假 `fetchImpl` 复现不了 undici 的 abort/取消与连接释放语义。断言全部是有界等待
    （远小于 vitest `testTimeout`），不写精确到毫秒的相等断言；deadline 取几百毫秒量级
    但要求"活过 deadline 的 3 倍"，从而既跑得快又抗 CI 抖动。

## 后果

* 空闲会话的 SSE 可以长期存活；活跃流在收到响应头后不再有"隐性 10 秒上限"。
* 断流时间不再与 BFF 客户端的 deadline 绑定；真要排查断流，只需看 router 的复核与
  调用方 signal（撤权/断开/关闭），不再有第二套隐藏计时器。
* 空闲会话上的 `return()`/撤权从"靠定时器救"变为"靠显式取消"，行为在有无 deadline 时一致。
* **迭代器从未启动就 `return()` / 撤权 / `throw()` 时，上游连接同样会被释放**：
  不再出现"调用方以为已经收尾、连接却永远挂着"的泄漏。
* `fetch` 在 abort 之后才解析出响应的竞态按 `timeout` / `aborted` 失败，不会被当成一次
  成功的订阅。
* 建立阶段失败（连不上、永不回响应头、父级已 abort）的分类、可重试性与 HTTP 状态码
  **均未改变**，既有的 `runtime-stream.test.ts` 与集成测试不受影响。

## 验证要求

* 收到响应头后，空闲流与活跃流都必须活过 deadline 的 3 倍（旧实现必失败，作为回归护栏）。
* 响应头之后、迭代器启动之前的父级 abort 必须立即结束；迭代过程中的 abort 同样立即结束。
* 永不返回响应头的连接仍在 deadline 处以 `kind: "timeout"` 失败。
* 提前 `return()`（含"正有一个挂起的 read"）、`for await` 中 `break`（reader cancel）、
  自然 EOF 三种收尾都必须有界收敛，并真的关闭上游连接（服务端观察到连接关闭）。
* **未启动迭代器**就 `return()` / `throw()` / 被父级 abort：假 `fetchImpl` 的
  `ReadableStream.cancel` 计数必须恰好为 1（旧实现为 0）；父级 signal 在
  `return()` 之后不得残留监听器；已缓冲帧场景（服务端保持连接）也必须真正关闭连接。
* 竞态：deadline 触发后 `fetch` 才解析出响应，必须返回 `kind: "timeout"`（fail-closed），
  并取消迟到的响应体。
* 流式 HTTP 失败仍为 `kind: "http"`、状态码与 `code` 保留、`reason` 不回显上游文本；
  非流式 deadline 不变；`turn/end` 只有 `completed` 是成功终态（授权取消不投影成完成）。

## 边界

本决策只保证"建立之后不再被建立截止时间杀掉"，不等于会话一定可持续：租约到期、撤权、
成员停用、进程重启等仍会（且应当）结束流 —— 那些路径在 router 的持续复核里，本层不重复实现。
