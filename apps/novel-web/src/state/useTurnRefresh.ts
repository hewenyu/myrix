import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { workKeys } from "./useWorks";

/**
 * 服务器业务缓存的合并窗口。
 *
 * 一次**历史回放**会在几百毫秒内连续投递几十条持久事件（每条终态都使
 * `settlements` +1）。如果不合并，就会变成"每个 event 一次 GET"的刷屏。
 *
 * 语义是"**首次**终态起算、窗口内不推迟"：第一个终态在 250ms 后触发一次失效，
 * 窗口内到达的后续终态只是并入这一次（不会把计时器一再往后推，否则持续回放
 * 会让刷新永远不落地）。因此刷新频率有上界 = 每 250ms 最多一次，
 * 而真实回合之间相隔数秒，每个真实回合仍然恰好刷新一次。
 */
const COALESCE_MS = 250;

/**
 * 失效**当前作品**的全部业务读取（大纲 / 章节列表+正文+版本 / 设定圣经）。
 *
 * 只用既有 query key 前缀（与保存成功后的失效模式完全一致，见 `useWorkspace`）：
 *   * `workKeys.outline(workId)` 精确匹配大纲；
 *   * `workKeys.chapters(workId)` 是章节列表、单章正文、版本历史的共同前缀；
 *   * `["works", workId, "bible"]` 是设定检索所有 query 变体的前缀。
 *
 * 刻意**不**碰作品列表（与模型写入无关），也**不**跨作品失效：失效只会触发
 * 重新读取，不会写入任何缓存，因此迟到的请求不可能覆盖别的作品。
 */
export function invalidateWorkBusinessQueries(queryClient: QueryClient, workId: string): void {
  void queryClient.invalidateQueries({ queryKey: workKeys.outline(workId) });
  void queryClient.invalidateQueries({ queryKey: workKeys.chapters(workId) });
  void queryClient.invalidateQueries({ queryKey: ["works", workId, "bible"] });
}

/**
 * 重新读取会话列表。
 *
 * 会话状态（`creating | active | revoked`）只由服务端给出：模型侧写入不会改变它，
 * 但 `creating → active` 是 BFF 在 create 命令拿到 driver 回执后写进数据库的。
 * 前端因此**不能**猜这个状态，只能在观察到"这个会话真的已经可用"之后重新读取：
 * 能成功订阅事件流（`GET /sessions/:id/events`）本身就证明绑定已经是 active，
 * 否则 BFF 会以 `session_not_active` 拒绝。
 */
export function invalidateSessionList(queryClient: QueryClient, workId: string): void {
  void queryClient.invalidateQueries({ queryKey: workKeys.sessions(workId) });
}

export interface TurnRefreshInput {
  /** 当前选中的作品；模型只能写它所属的作品。 */
  workId: string | null;
  /** 当前事件流对应的会话；切换会话必须重置合并窗口。 */
  sessionId: string | null;
  /** 已观察到的持久回合终态次数（`ChatState.settlements`，单调递增）。 */
  settlements: number;
  /** 事件流是否已连接（连接成功 = 该会话在服务端已经可用）。 */
  connected: boolean;
}

interface Baseline {
  sessionId: string | null;
  workId: string | null;
  settlements: number;
}

/**
 * 持久回合结束后重新读取**当前作品**的业务缓存。
 *
 * 规则：
 *   1. 只由**持久终态**驱动（`settlements` 变化）。瞬态 delta / 工具调用 / 连接
 *      事件都不触发读取，因此不会因为流式输出而刷屏。
 *   2. 合并窗口内的多次终态只触发一次失效（历史回放 = 一次读取，而不是每条事件一次）。
 *   3. 只失效当前 `workId` 的既有业务 query；切作品/切会话时基线重置，
 *      迟到的刷新不会打到新的作品或会话上。计数**下降**（切换会话那一帧还会
 *      看到旧流的计数）同样视为"归属改变"：取消旧窗口并以新计数重建基线，
 *      绝不让新会话的基线停在旧会话的高位。
 *   4. **不**用模型回复正文去填编辑器：这里只让服务器数据重新读取，
 *      编辑器是否采用新文本由 `useDraft` 的"脏草稿保护"决定。
 */
export function useTurnRefresh({ workId, sessionId, settlements, connected }: TurnRefreshInput): void {
  const queryClient = useQueryClient();
  const baselineRef = useRef<Baseline>({ sessionId, workId, settlements });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedSessionRef = useRef<string | null>(null);

  const cancelTimer = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    const baseline = baselineRef.current;
    if (baseline.sessionId !== sessionId || baseline.workId !== workId) {
      // 换了会话或作品：当前状态属于另一条流/另一个作品，重新建立基线，
      // 并取消尚未触发的合并窗口，避免迟到的请求打到新的作品上。
      cancelTimer();
      baselineRef.current = { sessionId, workId, settlements };
      return;
    }
    if (settlements === baseline.settlements) return;
    if (settlements < baseline.settlements) {
      // 计数**下降**只可能来自"切换会话时旧流的计数还没被重置"这一帧：
      // `useSessionStream` 的 effect 清空晚一轮，于是先看到旧会话的 4，再看到
      // 新会话从 0 重新计数。下降不是一次完成，绝不能把新会话的基线钉在 4
      // （那样新会话前几轮终态 <= 4 都会被当成"没有推进"而永不刷新）。
      // 这里显式取消旧窗口并重新建立基线，等待新会话自己的计数推进。
      cancelTimer();
      baselineRef.current = { sessionId, workId, settlements };
      return;
    }
    baselineRef.current = { sessionId, workId, settlements };
    if (!workId) return;
    // 已经在合并窗口里就不再重置计时器：窗口从**第一次**终态起算。
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // 触发时再核对一次身份：窗口期内切了作品/会话就不发这条迟到的失效。
      const current = baselineRef.current;
      if (current.sessionId !== sessionId || current.workId !== workId) return;
      invalidateWorkBusinessQueries(queryClient, workId);
    }, COALESCE_MS);
  }, [queryClient, sessionId, settlements, workId]);

  /**
   * 会话卡状态：`creating → active` 是服务端在 create 命令拿到 driver 回执后
   * 自己写的。前端只在一个真实证据出现时重新读取——事件流订阅成功。
   *
   * 这也顺带覆盖了"问题 3"的会话卡：订阅成功说明绑定已经是 `active`，
   * 列表刷新后会显示服务端的真实状态，而不是一直停在"创建中"。
   */
  useEffect(() => {
    if (!connected || !sessionId || !workId) {
      connectedSessionRef.current = null;
      return;
    }
    if (connectedSessionRef.current === sessionId) return;
    connectedSessionRef.current = sessionId;
    invalidateSessionList(queryClient, workId);
  }, [connected, queryClient, sessionId, workId]);

  useEffect(() => cancelTimer, []);
}
