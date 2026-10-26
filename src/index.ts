/**
 * Entry point: load config, start the REST server, and wire up graceful
 * shutdown. IMAP connections are made on demand per request by the fetcher,
 * so there's nothing to start up front.
 */

import "dotenv/config";
import { loadConfig } from "./config.js";
import { OtpFetcher } from "./otpFetcher.js";
import { createServer } from "./server.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const fetcher = new OtpFetcher(config);
  const app = createServer(fetcher);

  const server = app.listen(config.serverPort, config.serverHost, () => {
    log.info("server.listening", { host: config.serverHost, port: config.serverPort });
  });

  const shutdown = async (signal: string) => {
    log.info("shutdown.begin", { signal });
    server.close();
    await fetcher.stop();
    log.info("shutdown.done", {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { error: (err as Error).message });
  process.exit(1);
});
