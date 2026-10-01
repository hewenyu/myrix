import { useSyncExternalStore } from "react";

/**
 * 传输层状态：BFF 是否可达、SSE 是否在线。
 * 只由真实的请求/连接结果驱动，不做乐观假设，也不用于伪造业务状态。
 */
export interface TransportState {
  /** 最近一次 HTTP 请求是否成功抵达 BFF（含 4xx/5xx 业务响应）。 */
  reachable: boolean;
  /** 最近一次传输失败的可读原因。 */
  lastError: string | null;
  /** 最近一次成功抵达 BFF 的时间（毫秒）。 */
  lastOkAt: number | null;
  /** 当前是否有活跃的 SSE 连接。 */
  streamConnected: boolean;
}

const initialState: TransportState = {
  reachable: true,
  lastError: null,
  lastOkAt: null,
  streamConnected: false,
};

let state: TransportState = initialState;
const listeners = new Set<() => void>();

function emit(next: TransportState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function reportReachable(reachedAt: number = Date.now()): void {
  emit({ ...state, reachable: true, lastError: null, lastOkAt: reachedAt });
}

export function reportUnreachable(message: string): void {
  emit({ ...state, reachable: false, lastError: message });
}

export function reportStreamConnected(connected: boolean, message?: string): void {
  emit({
    ...state,
    streamConnected: connected,
    ...(connected ? {} : message ? { lastError: message } : {}),
  });
}

export function resetTransportState(): void {
  emit(initialState);
}

export function getTransportState(): TransportState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTransportState(): TransportState {
  return useSyncExternalStore(subscribe, getTransportState, getTransportState);
}
