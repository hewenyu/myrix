import type { Obligation } from "@myrix/contracts";

/** 已知沙箱档位 → 严格程度（数字越大越宽松） */
const SANDBOX_RANK: Record<string, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

/**
 * 未知沙箱档位归一为最严格的 `read-only`。
 *
 * 历史实现直接用 `SANDBOX_RANK[item.mode]`，未知档位得到 `undefined`：
 * 与数字比较恒为 false，结果取决于它是否恰好是数组首元素 —— 顺序相关，
 * 且某些排列下会把未知档位当成最宽松输出。这里显式归一，
 * 既保证"权限只能收紧"（硬性规则 2），也保证合并结果与输入顺序无关。
 */
function sandboxRankOf(mode: string): number {
  return SANDBOX_RANK[mode] ?? SANDBOX_RANK["read-only"]!;
}

/** 把未知/畸形档位归一为最严格档，再取最严格者（结果与输入顺序无关） */
function strictestSandboxMode(modes: readonly string[]): "read-only" | "workspace-write" | "danger-full-access" {
  const normalized = modes.map((mode) =>
    mode === "danger-full-access" || mode === "workspace-write" ? mode : "read-only",
  );
  return normalized.reduce(
    (acc, mode) => (sandboxRankOf(mode) < sandboxRankOf(acc) ? mode : acc),
    "danger-full-access" as "read-only" | "workspace-write" | "danger-full-access",
  );
}

function intersect(left: string[], right: string[]): string[] {
  return left.filter((item) => right.includes(item));
}

/**
 * 义务合并规则（多条规则同时命中时）：
 * - sandbox：取最严格的一档（权限只能收紧，不能被放宽）
 * - approval：任一规则要求审批即要求审批
 * - rateLimit：同一 key 取最小值
 * - audit：任一要求 full 即 full
 * - knowledgeScope / modelScope：取交集（范围只能缩小）
 */
export function mergeObligations(obligations: readonly Obligation[]): Obligation[] {
  const merged: Obligation[] = [];

  const sandbox = obligations.filter(
    (item): item is Extract<Obligation, { kind: "sandbox" }> => item.kind === "sandbox",
  );
  if (sandbox.length > 0) {
    // 未知档位（策略被写坏/来自旧版本）归一为 read-only，绝不放宽；
    // 并且合并结果只取决于集合内容，不取决于输入顺序。
    merged.push({ kind: "sandbox", mode: strictestSandboxMode(sandbox.map((item) => item.mode)) });
  }

  const approval = obligations.filter(
    (item): item is Extract<Obligation, { kind: "approval" }> => item.kind === "approval",
  );
  if (approval.length > 0) {
    const required = approval.some((item) => item.required);
    const reasons = [
      ...new Set(
        approval.map((item) => item.reason).filter((reason): reason is string => Boolean(reason)),
      ),
    ];
    merged.push(
      reasons.length > 0
        ? { kind: "approval", required, reason: reasons.join("; ") }
        : { kind: "approval", required },
    );
  }

  const rateLimits = obligations.filter(
    (item): item is Extract<Obligation, { kind: "rateLimit" }> => item.kind === "rateLimit",
  );
  for (const key of [...new Set(rateLimits.map((item) => item.key))]) {
    const perMinute = Math.min(
      ...rateLimits.filter((item) => item.key === key).map((item) => item.perMinute),
    );
    merged.push({ kind: "rateLimit", key, perMinute });
  }

  const audit = obligations.filter(
    (item): item is Extract<Obligation, { kind: "audit" }> => item.kind === "audit",
  );
  if (audit.length > 0) {
    merged.push({ kind: "audit", level: audit.some((item) => item.level === "full") ? "full" : "metadata" });
  }

  const knowledgeScope = obligations.filter(
    (item): item is Extract<Obligation, { kind: "knowledgeScope" }> => item.kind === "knowledgeScope",
  );
  if (knowledgeScope.length > 0) {
    merged.push({ kind: "knowledgeScope", baseIds: knowledgeScope.map((item) => item.baseIds).reduce(intersect) });
  }

  const modelScope = obligations.filter(
    (item): item is Extract<Obligation, { kind: "modelScope" }> => item.kind === "modelScope",
  );
  if (modelScope.length > 0) {
    merged.push({ kind: "modelScope", models: modelScope.map((item) => item.models).reduce(intersect) });
  }

  const seen = new Set<string>();
  for (const item of obligations) {
    if (item.kind !== "custom") continue;
    const key = item.name + ":" + JSON.stringify(item.params);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged;
}
