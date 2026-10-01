/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** BFF 基地址，默认同源 `/api/v1`。 */
  readonly VITE_BFF_BASE?: string;
  /** 开发代理目标（仅 vite dev 使用）。 */
  readonly VITE_BFF_ORIGIN?: string;
  readonly VITE_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
