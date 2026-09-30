/**
 * 动作/资源通配匹配。
 *
 * 约定：星号匹配任意字符（含分隔符冒号），也就是说
 *   "tool:*" 匹配 "tool:bash" 与 "tool:fs:write"
 *   "kb:*"   匹配 "kb:finance-2024"
 *   "*"      匹配一切
 * 大小写敏感，符合策略书写习惯。手写匹配以避免正则转义带来的歧义。
 */
export function globMatches(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  const parts = pattern.split("*");
  if (parts.length === 1) return value === pattern;
  const head = parts[0] ?? "";
  if (head.length > 0 && !value.startsWith(head)) return false;
  let cursor = head.length;
  for (let index = 1; index < parts.length - 1; index += 1) {
    const part = parts[index] ?? "";
    if (part.length === 0) continue;
    const found = value.indexOf(part, cursor);
    if (found === -1) return false;
    cursor = found + part.length;
  }
  const tail = parts[parts.length - 1] ?? "";
  if (tail.length === 0) return cursor <= value.length;
  if (!value.endsWith(tail)) return false;
  return value.length - tail.length >= cursor;
}

export function matchesAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => globMatches(pattern, value));
}
