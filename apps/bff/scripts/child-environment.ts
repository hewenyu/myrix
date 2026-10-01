/** Never spread process.env into a service or Cell child. The coordinator may hold all secrets. */
const OS_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC"] as const;
export function operatingEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(OS_KEYS.flatMap(key => parent[key] === undefined ? [] : [[key, parent[key]]])) as NodeJS.ProcessEnv;
}
const BFF_KEYS = ["DATABASE_URL", "MYRIX_AUTH_DATABASE_URL", "MYRIX_AUTH_MODE", "MYRIX_ORIGIN", "MYRIX_BIND_HOST", "MYRIX_PORT", "MYRIX_STATIC_ROOT", "MYRIX_SESSION_TTL_SECONDS", "MYRIX_DEV_USERS", "MYRIX_WORKS_HOST", "MYRIX_WORKS_PORT", "MYRIX_CELL_CREDENTIALS", "MYRIX_RUNTIME_CELLS_JSON", "MYRIX_RUNTIME_SIGNING_KEY_PEM", "MYRIX_RUNTIME_SIGNING_KID", "MYRIX_RUNTIME_ISSUER", "MYRIX_RUNTIME_JWKS_JSON", "MYRIX_RUNTIME_OUTBOX_ENABLED"] as const;
const GATEWAY_KEYS = ["DATABASE_URL", "MYRIX_GATEWAY_DATABASE_URL", "MYRIX_GATEWAY_HOST", "MYRIX_GATEWAY_PORT"] as const;
const UPSTREAM_KEYS = ["MYRIX_GATEWAY_UPSTREAM_URL", "MYRIX_GATEWAY_UPSTREAM_MODEL", "MYRIX_GATEWAY_UPSTREAM_API_KEY", "MYRIX_GATEWAY_MODEL_ALLOWLIST", "MYRIX_GATEWAY_MAX_BODY_BYTES", "MYRIX_GATEWAY_MAX_OUTPUT_TOKENS", "MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS", "MYRIX_GATEWAY_UPSTREAM_TIMEOUT_MS", "MYRIX_GATEWAY_REVOKE_POLL_MS"] as const;
function pick(source: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(keys.flatMap(key => source[key] === undefined ? [] : [[key, source[key]]])) as NodeJS.ProcessEnv;
}
export function serviceEnvironment(role: "bff" | "gateway", configured: NodeJS.ProcessEnv, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...operatingEnvironment(parent), NODE_ENV: "development", NO_COLOR: "1",
    ...pick(configured, role === "bff" ? BFF_KEYS : GATEWAY_KEYS),
    ...(role === "gateway" ? pick(parent, UPSTREAM_KEYS) : {}),
  };
}

/** Assert defense-in-depth after combining the profile's own env/secrets with the minimal OS environment. */
export function assertCellSecretIsolation(env: NodeJS.ProcessEnv): void {
  const forbidden = /(?:DATABASE|MIGRAT|SIGNING_KEY|PRIVATE_KEY|UPSTREAM|API_KEY|OIDC|CREDENTIALS|NODE_OPTIONS|NODE_PATH|MYRIX_RUNTIME_CELLS_JSON|MYRIX_DEV_USERS|MYRIX_AUTH_)/;
  for (const name of Object.keys(env)) {
    if (forbidden.test(name)) throw new Error("Refusing to start a Cell with platform-only secrets or ambient module injection settings");
  }
}
