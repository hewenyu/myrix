/**
 * 版本化写入的返回形状。放在独立文件，避免 chapters/outline/bible 三个仓储互相 import。
 *
 * `status` 三态与 first-version.md 的接口基线一致；conflict **不**用返回值表达，
 * 而是抛 PlatformStoreError(code="version_conflict")，details 里带 currentVersion 与当前正文，
 * 这样调用方（模型工具 / BFF）无法忽略冲突继续往下写。
 */

export interface SaveResult {
  status: "saved" | "duplicate";
  version: number;
  contentHash: string;
  updatedAt: string;
  /** 可读原因，进审计与日志 */
  reason: string;
}

export interface ConflictDetails {
  currentVersion: number;
  currentText?: string;
  currentDocument?: unknown;
  currentContentHash: string;
}
