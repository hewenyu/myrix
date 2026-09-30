/**
 * 属性路径解析：支持 "subject.department"、"resource.attributes.level"、
 * "subject.groups" 这类点号路径，方便策略以声明式方式引用上下文。
 */
export function getPath(source: unknown, path: string): unknown {
  if (path.length === 0) return source;
  const segments = path.split(".");
  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (Number.isInteger(index)) {
        current = current[index];
        continue;
      }
      // 对数组做投影，支持形如 subject.groups 的取值
      current = current.map((item) =>
        item !== null && typeof item === "object"
          ? (item as Record<string, unknown>)[segment]
          : undefined,
      );
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
