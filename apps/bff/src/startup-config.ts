import { createPrivateKey, createPublicKey } from "node:crypto";
import type { GrantPublicJwk } from "@myrix/grant";
import { isUuid } from "@myrix/platform-store";
import { readEnvironment } from "./config";
import { readRuntimeEnvironment } from "./runtime-config";
import { createStaticCellDirectory } from "./runtime-cells";
import { CellCredentialRegistry, type CellCredential } from "./works-server";

function json(env: NodeJS.ProcessEnv, field: string): unknown {
  try {
    if (!env[field]) throw new Error();
    return JSON.parse(env[field]);
  } catch { throw new Error(`${field} must contain explicit valid JSON`); }
}

/** Validate the complete deployment manifest before opening any database connection. */
export function readStartupEnvironment(env: NodeJS.ProcessEnv) {
  const bff = readEnvironment(env);
  const runtime = readRuntimeEnvironment(env);
  createStaticCellDirectory(runtime.cells);
  if (runtime.outboxEnabled === false) throw new Error("Production assembly requires the durable revoke outbox");
  if (new URL(bff.databaseUrl).username === new URL(bff.authDatabaseUrl).username) throw new Error("Business and authentication require separate database logins");
  const worksHost = env.MYRIX_WORKS_HOST ?? "127.0.0.1";
  if (bff.mode === "development" && !["127.0.0.1", "::1"].includes(worksHost)) throw new Error("Development works service must bind loopback");
  const port = env.MYRIX_WORKS_PORT ?? "8791";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || Number(port) === bff.port) throw new Error("MYRIX_WORKS_PORT must be a distinct valid port");
  const raw = json(env, "MYRIX_CELL_CREDENTIALS");
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Cell credentials must be a nonempty array");
  const credentials: CellCredential[] = [];
  const seenCells = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => !["tenantId", "cellId", "token"].includes(key))
      || typeof row.tenantId !== "string" || !isUuid(row.tenantId) || typeof row.cellId !== "string" || !/^[A-Za-z0-9._:@-]{1,128}$/.test(row.cellId)
      || typeof row.token !== "string" || row.token.length < 32 || /\s/.test(row.token)) throw new Error("Invalid Cell credential binding");
    if (seenCells.has(row.cellId)) throw new Error("A Cell may have only one tenant credential binding");
    seenCells.add(row.cellId);
    if (!runtime.cells.some(cell => cell.cellId === row.cellId && cell.tenantId === row.tenantId)) throw new Error("Cell credential does not match the placement tenant");
    credentials.push({ tenantId: row.tenantId, cellId: row.cellId, token: row.token });
  }
  const registry = new CellCredentialRegistry(credentials);
  for (const cell of runtime.cells) {
    if (!seenCells.has(cell.cellId)) throw new Error("Placement has no works credential binding");
    if (!cell.serviceToken || cell.serviceToken.length < 32 || /\s/.test(cell.serviceToken)) throw new Error("Each Cell requires an explicit admin credential of at least 32 characters");
  }
  const publicManifest = json(env, "MYRIX_RUNTIME_JWKS_JSON");
  if (!publicManifest || typeof publicManifest !== "object" || Array.isArray(publicManifest)) throw new Error("Runtime public-key manifest must map Cell IDs to public JWK arrays");
  const expected = createPublicKey(createPrivateKey(runtime.signingKeyPem)).export({ format: "jwk" });
  const jwksByCell: Record<string, readonly GrantPublicJwk[]> = Object.create(null);
  for (const cell of runtime.cells) {
    const keys: unknown = (publicManifest as Record<string, unknown>)[cell.cellId];
    if (!Array.isArray(keys) || keys.some(key => !key || typeof key !== "object" || Array.isArray(key) || "d" in key)) throw new Error("Cell public-key manifest is missing or contains private key material");
    if (!keys.some(key => key.kid === runtime.signingKid && key.kty === "EC" && key.crv === "P-256" && key.x === expected.x && key.y === expected.y
      && (key.alg === undefined || key.alg === "ES256") && (key.use === undefined || key.use === "sig"))) throw new Error("Cell public-key manifest does not match the active signing key");
    jwksByCell[cell.cellId] = keys as GrantPublicJwk[];
  }
  return { bff, runtime, registry, jwksByCell, worksHost, worksPort: Number(port) };
}
