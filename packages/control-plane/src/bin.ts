import { createControlPlane } from "./server";
import { GovernanceStore } from "./store";

const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "127.0.0.1";
const adminToken = process.env.MYRIX_ADMIN_TOKEN ?? "dev-admin-token";

const store = new GovernanceStore();
const controlPlane = createControlPlane({ store, adminToken });
const { url } = await controlPlane.listen(port, host);

console.log("[myrix] 控制面已启动:", url);
console.log("[myrix] 管理后台:", url + "/");
console.log("[myrix] 健康检查:", url + "/healthz");
if (adminToken === "dev-admin-token") {
  console.warn("[myrix] 警告：正在使用默认开发令牌 dev-admin-token，请在生产环境设置 MYRIX_ADMIN_TOKEN");
}
