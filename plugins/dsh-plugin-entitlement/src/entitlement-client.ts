import type { EntitlementSet } from "@myrix/contracts";

export interface EntitlementClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class EntitlementClient {
  constructor(private readonly options: EntitlementClientOptions) {}

  async fetchFor(principalId: string): Promise<EntitlementSet> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 3000);
    try {
      const response = await fetchImpl(
        this.options.baseUrl.replace(/\/+$/, "") + "/api/v1/principals/" + encodeURIComponent(principalId) + "/entitlements",
        {
          headers: { authorization: "Bearer " + this.options.token },
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error("控制面返回 " + response.status.toString());
      return (await response.json()) as EntitlementSet;
    } finally {
      clearTimeout(timer);
    }
  }
}
