import type { Obligation } from "@myrix/contracts";

const SANDBOX_RANK: Record<"read-only" | "workspace-write" | "danger-full-access", number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

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
    const mode = sandbox.reduce(
      (acc, item) => (SANDBOX_RANK[item.mode] < SANDBOX_RANK[acc] ? item.mode : acc),
      sandbox[0]!.mode,
    );
    merged.push({ kind: "sandbox", mode });
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
