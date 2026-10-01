/** Runtime uses independent LOGIN roles, persistent PostgreSQL quota, and current business authority. */
import { createProductionGateway } from "./production";

try {
  const { server, runtime, config } = await createProductionGateway();
  try {
    const address = await server.listen({ port: config.port, host: config.host });
    console.log(`[myrix-model-gateway] listening on ${address}; credentialSource=postgres; ledger=postgres`);
    if (!runtime.diagnostics.upstreamConfigured) {
      console.error("[myrix-model-gateway] 未配置上游 API key：模型请求返回 503，不存在模拟降级");
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => { void server.close().catch(() => { process.exitCode = 1; }); });
    }
  } catch (error) { await server.close(); throw error; }
} catch {
  // PostgreSQL/upstream/config errors may contain credentials; never print their raw messages.
  console.error("[myrix-model-gateway] 启动失败：请检查运行角色、迁移、数据库及网关环境配置（未记录敏感值）");
  process.exitCode = 1;
}
