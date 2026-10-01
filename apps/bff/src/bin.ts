#!/usr/bin/env tsx
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProductionBff } from "./production";

export async function main() {
  const application = await createProductionBff();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { console.error("Myrix BFF shutdown deadline exceeded"); process.exit(1); }, 15_000);
    deadline.unref();
    application.close().catch(() => { console.error("Myrix BFF shutdown failed"); process.exitCode = 1; })
      .finally(() => { clearTimeout(deadline); process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    await application.start();
    console.log(`Myrix BFF ready (port ${application.diagnostics.bffPort}); works service ready (port ${application.diagnostics.worksPort})`);
  } catch {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await application.close().catch(() => undefined);
    throw new Error("Myrix BFF startup failed");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Myrix BFF refused to start: check explicit configuration, migrations, low-privilege LOGIN roles and available ports. Secrets were not logged.");
    process.exitCode = 1;
  });
}
