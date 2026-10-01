/**
 * 已知模型 allowlist。只做显式 allowlist 匹配：
 * 未配置在清单里的模型一律 403，不做前缀通配、不做"未知放行"。
 */
import { modelNotAllowed } from "./errors";

export interface ModelAllowlist {
  readonly entries: readonly string[];
  has(model: string): boolean;
  /** 不在清单则抛 403；返回模型名便于链式使用 */
  require(model: string): string;
}

export function createModelAllowlist(entries: readonly string[]): ModelAllowlist {
  const set = new Set<string>();
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) throw new Error("模型 allowlist 不能包含空字符串");
    set.add(trimmed);
  }
  if (set.size === 0) throw new Error("模型 allowlist 不能为空：模型网关不提供默认模型");
  const frozen = Object.freeze([...set]);
  return {
    entries: frozen,
    has: (model: string) => set.has(model),
    require: (model: string) => {
      if (!set.has(model)) throw modelNotAllowed(model);
      return model;
    },
  };
}
