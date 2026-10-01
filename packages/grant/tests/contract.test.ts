import { describe, expect, it } from "vitest";
import {
  CLAIM_SPECS,
  GRANT_ERROR_CODES,
  GRANT_OPERATIONS,
  KNOWN_CLAIMS,
  GrantError,
  decodeBase64Url,
  encodeBase64Url,
  isIdentifier,
  isNonNegativeInteger,
  isPlainString,
  isSha256Hex,
  parseBearerToken,
  sha256Hex,
  stageOf,
} from "../src/index";
import { expectCode } from "./helpers";

describe("claim 表完整性", () => {
  it("覆盖技术方案 §3.1 的全部 15 个 claim", () => {
    expect(CLAIM_SPECS.map((spec) => spec.name).sort()).toEqual(
      ["iss", "aud", "boot", "tid", "sid", "sub", "wid", "preset", "rev", "op", "cmd", "bh", "jti", "iat", "exp"].sort(),
    );
    expect(KNOWN_CLAIMS.size).toBe(15);
  });

  it("每个 claim 都有中文可读描述", () => {
    for (const spec of CLAIM_SPECS) {
      expect(spec.describe.length).toBeGreaterThan(0);
      expect(spec.verifiedAt.length).toBeGreaterThan(0);
    }
  });

  it("错误码与阶段一一对应，没有孤儿码", () => {
    const stages = new Set(["format", "signature", "claims", "time", "binding", "replay", "configuration"]);
    for (const code of GRANT_ERROR_CODES) {
      expect(stages.has(stageOf(code))).toBe(true);
      expect(stageOf(code)).toBe(new GrantError(code, "x").stage);
    }
  });

  it("错误细节只允许标量（防止把 token/正文塞进响应体）", () => {
    const error = new GrantError("grant/invalid-claims", "x", { claim: "rev", actual: "number(-1)", retriable: false });
    for (const value of Object.values(error.toWire().details)) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
    expect(JSON.stringify(error.toWire())).not.toContain("token");
  });
});

describe("标识符与摘要类型守卫", () => {
  it("isIdentifier：拒绝空、超长、空白、控制字符", () => {
    expect(isIdentifier("sid-1")).toBe(true);
    expect(isIdentifier("u_1001")).toBe(true);
    expect(isIdentifier("a".repeat(128))).toBe(true);
    expect(isIdentifier("a".repeat(129))).toBe(false);
    expect(isIdentifier("")).toBe(false);
    expect(isIdentifier("a b")).toBe(false);
    expect(isIdentifier("a\tb")).toBe(false);
    expect(isIdentifier("a\u0000b")).toBe(false);
    expect(isIdentifier(1)).toBe(false);
    expect(isIdentifier(null)).toBe(false);
  });

  it("isPlainString 允许内部空格（preset/iss 等），isIdentifier 更严", () => {
    expect(isPlainString("novel-chapter")).toBe(true);
    expect(isPlainString("myrix control plane")).toBe(true);
    expect(isPlainString("")).toBe(false);
    expect(isPlainString("x".repeat(129))).toBe(false);
    expect(isIdentifier("myrix control plane")).toBe(false);
  });

  it("isNonNegativeInteger 拒绝负数、小数与 NaN", () => {
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(7)).toBe(true);
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isNonNegativeInteger(Number.NaN)).toBe(false);
    expect(isNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isNonNegativeInteger("7")).toBe(false);
  });

  it("isSha256Hex 只认 64 位小写十六进制", () => {
    expect(isSha256Hex(sha256Hex("x"))).toBe(true);
    expect(isSha256Hex(sha256Hex("x").toUpperCase())).toBe(false);
    expect(isSha256Hex(sha256Hex("x").slice(0, 63))).toBe(false);
    expect(isSha256Hex("z".repeat(64))).toBe(false);
    expect(isSha256Hex(null)).toBe(false);
  });
});

describe("base64url 编解码", () => {
  it("往返一致，且不含标准 base64 的 + / =", () => {
    for (const bytes of [Buffer.from([0]), Buffer.from([255, 254, 253]), Buffer.from("中文")]) {
      const encoded = encodeBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(Buffer.from(decodeBase64Url(encoded))).toEqual(bytes);
    }
  });

  it("空字节序列编码为空段，而空段在解析时被拒（JWS 里空段永远非法）", () => {
    expect(encodeBase64Url(Buffer.alloc(0))).toBe("");
    expectCode(() => decodeBase64Url(""), "grant/malformed");
  });

  it("空段与含 padding 的段被拒", () => {
    expectCode(() => decodeBase64Url(""), "grant/malformed");
    expectCode(() => decodeBase64Url("YQ=="), "grant/malformed");
    expectCode(() => decodeBase64Url("YQ "), "grant/malformed");
  });
});

describe("Bearer 解析（驱动入口）", () => {
  it("正常解析", () => {
    expect(parseBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(parseBearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("缺失 / 空 / 错误 scheme / 多 token / 带空白 → malformed", () => {
    for (const value of [undefined, null, "", "abc.def.ghi", "Basic abc", "Bearer", "Bearer ", "Bearer a b", "Token abc"]) {
      expectCode(() => parseBearerToken(value as never), "grant/malformed");
    }
  });

  it("超长头被拒", () => {
    expectCode(() => parseBearerToken(`Bearer ${"a".repeat(9100)}`), "grant/malformed");
  });

  it("解析出的 token 可直接进校验器，并保持同一套错误码", () => {
    const header = encodeBase64Url(Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "k" })));
    const payload = encodeBase64Url(Buffer.from(JSON.stringify({ op: "send" })));
    const token = `${header}.${payload}.${encodeBase64Url(Buffer.alloc(64))}`;
    expect(parseBearerToken(`Bearer ${token}`)).toBe(token);
  });
});

describe("操作集合", () => {
  it("与 §3.1 的 op 取值一致，顺序稳定", () => {
    expect([...GRANT_OPERATIONS]).toEqual(["create", "resume", "send", "cancel", "subscribe"]);
  });
});
