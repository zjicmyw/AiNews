import { config } from "./config.js";
import { DbClient } from "./db.js";
import { EnginePipeline } from "./pipeline.js";
import { createHttpServer } from "./httpServer.js";
import { TradingViewSignalStore } from "./tradingViewSignalStore.js";
import { logger } from "./logger.js";

async function main() {
  const db = new DbClient(config.dbPath);
  const tradingViewSignalStore = new TradingViewSignalStore();
  const pipeline = new EnginePipeline({ config, db, tradingViewSignalStore });

  const server = createHttpServer({
    config,
    db,
    tradingViewSignalStore,
    getRuntimeStatus: () => pipeline.getRuntimeStatus()
  });

  await pipeline.start();

  const shutdown = (signal) => {
    logger.warn("shutdown_signal", { signal });
    pipeline.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("fatal", { error: String(error.message || error) });
  process.exit(1);
});
