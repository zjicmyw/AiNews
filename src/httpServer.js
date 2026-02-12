import express from "express";
import { logger } from "./logger.js";

export function createHttpServer({ config, db, getRuntimeStatus, tradingViewSignalStore }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString(), stats: db.getStats() });
  });

  app.get("/status.json", (_req, res) => {
    const latest = db.getLatestRegimeStatus();
    const latestEvents = db.getLastHighEvents(8);
    const runtime = getRuntimeStatus();

    res.json({
      regime: latest.regime || runtime.regime || "Neutral",
      regime_probability: Number(latest.regime_probability ?? runtime.regime_probability ?? 50),
      risk_score: Number(latest.risk_score ?? runtime.risk_score ?? 0),
      market_confirmation: Number(latest.market_confirmation ?? runtime.market_confirmation ?? 0),
      latest_events: latestEvents,
      updated_at: runtime.updated_at || new Date().toISOString()
    });
  });

  app.post("/webhook/tradingview", (req, res) => {
    if (!config.enableTradingViewWebhook) {
      res.status(404).json({ ok: false, error: "webhook_disabled" });
      return;
    }

    const secret = req.get("x-tradingview-secret") || req.body?.secret || "";
    if (config.tradingViewWebhookSecret && secret !== config.tradingViewWebhookSecret) {
      res.status(401).json({ ok: false, error: "invalid_secret" });
      return;
    }

    const signal = {
      symbol: req.body?.symbol || "UNKNOWN",
      direction: req.body?.direction || req.body?.signal || "unknown",
      note: req.body?.note || ""
    };

    tradingViewSignalStore.save(signal);
    logger.info("tradingview_signal_received", signal);

    res.json({ ok: true });
  });

  const server = app.listen(config.appPort, () => {
    logger.info("http_server_started", { port: config.appPort });
  });

  return server;
}
