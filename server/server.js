import { createApp } from "./app.js";
import { readConfig } from "./config.js";

async function main() {
  const config = readConfig();
  const instance = await createApp({
    ...config,
    nodeEnv: config.nodeEnv,
    skipDistCheck: false,
  });
  instance.httpServer.listen(config.port, config.host, () => {
    console.log(`Collab Editor listening on ${config.publicOrigin}`);
  });
  const shutdown = async (signal) => {
    console.log(`Stopping after ${signal}.`);
    const forced = setTimeout(() => process.exit(1), 5000);
    forced.unref();
    await instance.close();
    clearTimeout(forced);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(
    `Startup failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
