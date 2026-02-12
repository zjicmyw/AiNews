function buildAdvice(level, analysis) {
  const assets = (analysis.assets || []).join(", ");
  if (level >= 3) {
    return `建议：降低 Alt 暴露，适度提高 BTC/稳定币权重。关注资产：${assets || "BTC, ALT"}`;
  }
  return `建议：控制新增高 Beta 仓位，保持防守，关注资产：${assets || "BTC, ALT"}`;
}

function fmtNum(value) {
  if (!Number.isFinite(value)) return "N/A";
  return value.toFixed(2);
}

export class TelegramNotifier {
  constructor(config) {
    this.config = config;
  }

  buildMessage({ level, event, analysis, scoreResult, marketSnapshot, degraded }) {
    const lines = [];
    lines.push(`【风险预警】Level ${level}`);
    lines.push(`RiskScore: ${fmtNum(scoreResult.risk_score)} | MarketConfirm: ${fmtNum(scoreResult.market_confirmation)}`);
    lines.push(`Regime: ${scoreResult.regime} (${scoreResult.regime_probability})`);
    lines.push(`事件: ${event.title}`);
    lines.push(`来源: ${event.source}`);
    lines.push(`链接: ${event.url || "N/A"}`);
    lines.push("风险解读:");
    for (const reason of (analysis.reasons || []).slice(0, 3)) {
      lines.push(`- ${reason}`);
    }
    lines.push(buildAdvice(level, analysis));

    if (degraded) {
      lines.push("注意：市场确认不足，按 Level 2 降级推送。");
    }

    if (marketSnapshot.is_data_anomaly && marketSnapshot.anomaly_reasons.length > 0) {
      lines.push(`数据异常: ${marketSnapshot.anomaly_reasons.slice(0, 2).join(" | ")}`);
    }

    return lines.join("\n");
  }

  async send({ message }) {
    if (!this.config.telegramEnabled) {
      return { ok: false, reason: "telegram_disabled" };
    }

    const mode = this.config.telegramMode === "direct" ? "direct" : "relay";

    try {
      let endpoint = "";
      const headers = { "Content-Type": "application/json" };
      let payload = {};
      let timeoutMs = 12000;

      if (mode === "relay") {
        if (!this.config.telegramServiceUrl || !this.config.telegramApiKey || !this.config.telegramChatId) {
          return { ok: false, reason: "telegram_relay_not_configured" };
        }
        const base = this.config.telegramServiceUrl.replace(/\/+$/, "");
        const configuredPath = this.config.telegramServicePath || "/send-message";
        const path = configuredPath.startsWith("/") ? configuredPath : `/${configuredPath}`;
        endpoint = `${base}${path}`;
        headers[this.config.telegramApiKeyHeader || "X-API-Key"] = this.config.telegramApiKey;
        payload = {
          chatId: this.config.telegramChatId,
          message
        };
        timeoutMs = 5000;
      } else {
        if (!this.config.telegramBotToken || !this.config.telegramChatId) {
          return { ok: false, reason: "telegram_direct_not_configured" };
        }
        endpoint = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
        payload = {
          chat_id: this.config.telegramChatId,
          text: message,
          disable_web_page_preview: true
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`telegram_${mode}_http_${response.status}:${text.slice(0, 200)}`);
      }

      return { ok: true, reason: `sent_${mode}` };
    } catch {
      // Intentionally ignore push failures to avoid blocking main loop.
      return { ok: false, reason: "send_ignored_failure" };
    }
  }
}
