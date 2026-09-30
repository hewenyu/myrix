/**
 * 按主体渲染 DSH profile 产物。
 *
 * 用法：
 *   pnpm render:profile u_1001                # 打印到标准输出
 *   pnpm render:profile u_1001 --out <dir>    # 写入 cordis.patch.yml / package.json / myrix-profile.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GovernanceStore } from "@myrix/control-plane";
import { renderDshProfile } from "@myrix/registry";

const args = process.argv.slice(2);
const principalId = args.find((arg) => !arg.startsWith("--")) ?? "u_1001";
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : undefined;

const store = new GovernanceStore();
const profile = store.profile(principalId);
if (!profile) {
  console.error("找不到主体：" + principalId);
  process.exit(1);
}

const rowConfig: Record<string, string> = {
  "myrix-plugin-governance": [
    "controlPlaneUrl: http://127.0.0.1:8787",
    "token: !!js process.env.MYRIX_AGENT_TOKEN",
    'principalId: "' + principalId + '"',
    "sessionId: !!js process.env.MYRIX_SESSION_ID",
    "failClosed: true",
  ].join("\n"),
  "myrix-plugin-entitlement": [
    "controlPlaneUrl: http://127.0.0.1:8787",
    "token: !!js process.env.MYRIX_AGENT_TOKEN",
    'principalId: "' + principalId + '"',
    "toolOwners: !!js JSON.parse(process.env.MYRIX_TOOL_OWNERS ?? '[]')",
    "refreshIntervalMs: 60000",
  ].join("\n"),
  "myrix-plugin-knowledge": [
    "controlPlaneUrl: http://127.0.0.1:8787",
    "token: !!js process.env.MYRIX_AGENT_TOKEN",
    'principalId: "' + principalId + '"',
    "tenantId: " + profile.spec.tenantId,
    "sessionId: !!js process.env.MYRIX_SESSION_ID",
  ].join("\n"),
};

const artifacts = renderDshProfile(profile.spec, store.catalog, { rowConfig });

if (outDir === undefined) {
  console.log("=== cordis.patch.yml ===");
  console.log(artifacts.cordisPatch);
  console.log("=== package.json ===");
  console.log(artifacts.packageJson);
  console.log("=== myrix-profile.json（中间表示，审计用）===");
  console.log(artifacts.manifest);
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "cordis.patch.yml"), artifacts.cordisPatch, "utf8");
await writeFile(join(outDir, "package.json"), artifacts.packageJson, "utf8");
await writeFile(join(outDir, "myrix-profile.json"), artifacts.manifest, "utf8");
console.log("已写入 " + outDir + "：cordis.patch.yml / package.json / myrix-profile.json");
console.log("启用功能 " + profile.spec.enabled.length.toString() + " 项，裁剪 " + profile.spec.disabled.length.toString() + " 项");
