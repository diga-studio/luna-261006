/**
 * 将任意 JSON 值规范化为确定性字符串：
 * 对象键按码点排序、无空白、数字走 JSON 语义。
 * 非 JSON 值（undefined、函数、Symbol、BigInt、循环引用、NaN/Infinity）一律拒绝。
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonicalJson: non-finite number is not valid JSON");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item) => {
          if (item === undefined || typeof item === "function" || typeof item === "symbol") {
            throw new TypeError("canonicalJson: unsupported array element");
          }
          return serialize(item);
        });
        return "[" + items.join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonicalJson: only plain objects are supported");
      }
      const parts: string[] = [];
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined || typeof v === "function" || typeof v === "symbol") {
          throw new TypeError("canonicalJson: unsupported object value");
        }
        parts.push(JSON.stringify(key) + ":" + serialize(v));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
