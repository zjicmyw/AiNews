import crypto from "node:crypto";
import { logger } from "../logger.js";
function fmtNum(value) {
  if (!Number.isFinite(value)) return "N/A";
  return value.toFixed(2);
}

function mapConfidence(confidence) {
  if (confidence === "high") return "高置信";
  if (confidence === "low") return "低置信";
  return "中置信";
}

function formatAssetActions(assetActions) {
  const items = Array.isArray(assetActions) ? assetActions.slice(0, 3) : [];
  if (items.length === 0) {
    return ["· BTC — 观望（低置信）：信息有限，建议保持谨慎。"];
  }
  return items.map((item) => {
    const asset = String(item?.asset || "BTC");
    const action = String(item?.action || "观望");
    const confidence = mapConfidence(item?.confidence);
    const rationale = String(item?.rationale || "信息有限，建议保持谨慎。");
    return `· ${asset} — ${action}（${confidence}）：${rationale}`;
  });
}

export class TelegramNotifier {
  constructor(config, db = null) {
    this.db = db;
    this.config = config;
  }

  buildMessage({ level, event, analysis, scoreResult, marketSnapshot, degraded }) {
    const lines = [];
    const title = String(analysis?.title_zh || "").trim() || event.title;

    lines.push(`【风险预警】Level ${level}`);
    lines.push(`RiskScore: ${fmtNum(scoreResult.risk_score)} | MarketConfirm: ${fmtNum(scoreResult.market_confirmation)}`);
    lines.push(`Regime: ${scoreResult.regime} (${scoreResult.regime_probability})`);
    lines.push("");
    lines.push(`事件: ${title}`);
    lines.push(`来源: ${event.source}`);
    lines.push(`链接: ${event.url || "N/A"}`);
    lines.push("");
    lines.push("风险解读:");
    for (const reason of (analysis?.reasons || []).slice(0, 2)) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
    lines.push("操作建议:");
    lines.push(...formatAssetActions(analysis?.asset_actions));

    if (degraded) {
      lines.push("注意：市场确认不足，按 Level 2 降级推送。");
    }

    if (marketSnapshot.is_data_anomaly && marketSnapshot.anomaly_reasons.length > 0) {
      lines.push(`数据异常: ${marketSnapshot.anomaly_reasons.slice(0, 2).join(" | ")}`);
    }

    return lines.join("\n");
  }

  asResult(row) {
    return { ok: ["queued", "sent", "suppressed"].includes(row.status), status: row.status,
      reason: row.reason || row.status, taskId: row.task_id || null, messageId: row.message_id || null };
  }

  parseReceipt(body, responseOk, mode) {
    const now = new Date().toISOString();
    if (mode === "direct") {
      if (responseOk && body?.ok === true && body.result?.message_id) {
        return { status: "sent", reason: "telegram_confirmed", messageId: body.result.message_id, acceptedAt: now, completedAt: now };
      }
      return { status: body?.ok === false ? "failed" : "unknown", reason: "direct_unconfirmed" };
    }
    const base = { taskId: body?.taskId || null, messageId: body?.messageId || null };
    if (body?.deliveryUnknown || body?.status === "delivery_unknown") return { ...base, status: "unknown", reason: "gateway_delivery_unknown" };
    if (responseOk && body?.success === true) {
      if (body.status === "sent" && body.taskId && body.messageId) return { ...base, status: "sent", reason: "gateway_confirmed", acceptedAt: body.createdAt || now, completedAt: body.completedAt || now };
      if (["queued", "sending", "retrying", "pending", "processing", "retry_scheduled"].includes(body.status) && body.taskId) return { ...base, status: "queued", reason: "gateway_accepted", acceptedAt: body.createdAt || now };
      if (body.status === "suppressed") return { ...base, status: "suppressed", reason: "gateway_suppressed", completedAt: now };
    }
    if (["failed", "expired"].includes(body?.status) || body?.success === false) return { ...base, status: "failed", reason: "gateway_rejected" };
    return { ...base, status: "unknown", reason: "invalid_gateway_receipt" };
  }

  preflight(chatId) {
    if (!this.config.telegramEnabled) return { ok: false, status: "disabled", reason: "telegram_disabled" };
    const mode = this.config.telegramMode === "direct" ? "direct" : "relay";
    if (!(chatId || this.config.telegramChatId) || (mode === "relay" ? !this.config.telegramServiceUrl || !this.config.telegramApiKey : !this.config.telegramBotToken)) {
      return { ok: false, status: "failed", reason: "configuration_missing" };
    }
    return { ok: true };
  }

  recordPreflight({ businessId, groupId, kind = "event", message = "", chatId }) {
    const payloadHash = crypto.createHash("sha256").update(JSON.stringify([String(chatId || this.config.telegramChatId || ""), message])).digest("hex");
    const identity = businessId || `content:${payloadHash}`;
    this.db?.recordNotificationPreflight?.({ business_id: identity, group_id: groupId || identity, kind,
      mode: this.config.telegramMode === "direct" ? "direct" : "relay",
      idempotency_key: `ainews:${crypto.createHash("sha256").update(identity).digest("hex")}`,
      payload_hash: payloadHash, created_at: new Date().toISOString() });
  }

  async send({ message, chatId, businessId, groupId, kind = "event" }) {
    const preflight = this.preflight(chatId);
    if (!preflight.ok) {
      if (preflight.status === "failed") this.recordPreflight({ businessId, groupId, kind, message, chatId });
      return preflight;
    }
    const mode = this.config.telegramMode === "direct" ? "direct" : "relay";
    const targetChatId = chatId || this.config.telegramChatId;
    const payloadHash = crypto.createHash("sha256").update(JSON.stringify([String(targetChatId), message])).digest("hex");
    const identity = businessId || `content:${payloadHash}`;
    const idempotencyKey = `ainews:${crypto.createHash("sha256").update(identity).digest("hex")}`;
    if (this.db?.claimNotificationDelivery) {
      const claimed = this.db.claimNotificationDelivery({ business_id: identity, group_id: groupId || identity,
        kind, mode, idempotency_key: idempotencyKey, payload_hash: payloadHash, created_at: new Date().toISOString() });
      if (!claimed) {
        const previous = this.db.getNotificationDelivery(identity);
        // A submitted business event is never blindly submitted again, even after a restart.
        if (previous.payload_hash !== payloadHash) return { ok: false, status: "unknown", reason: "business_payload_conflict" };
        return this.asResult(previous);
      }
    }
    const base = String(this.config.telegramServiceUrl || "").replace(/\/+$/, "");
    const path = `/${String(this.config.telegramServicePath || "/send-message").replace(/^\/+/, "")}`;
    const endpoint = mode === "relay" ? `${base}${path}` : `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
    const headers = { "Content-Type": "application/json" };
    if (mode === "relay") {
      headers[this.config.telegramApiKeyHeader || "X-API-Key"] = this.config.telegramApiKey;
      headers["X-Idempotency-Key"] = idempotencyKey;
    }
    // Persist gateway acceptance first; the existing receipt tick confirms delivery.
    // The relay's synchronous wait can exceed this client's submission deadline.
    const payload = mode === "relay" ? { chatId: targetChatId, message, idempotencyKey, mode: "async" }
      : { chat_id: targetChatId, text: message, disable_web_page_preview: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), mode === "relay" ? 5000 : 12000);
    let result;
    let httpStatus = null;
    let jsonReceipt = false;
    let transportFailure = null;
    try {
      const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal, redirect: "error" });
      httpStatus = response.status;
      const body = await response.json().then((value) => { jsonReceipt = true; return value; }).catch(() => null);
      result = this.parseReceipt(body, response.ok, mode);
    } catch {
      transportFailure = controller.signal.aborted ? "submission_timeout" : "transport_error";
      result = { status: "unknown", reason: "transport_outcome_unknown" };
    } finally {
      clearTimeout(timer);
    }
    if (!["queued", "sent", "suppressed"].includes(result.status)) {
      // Preserve the original submission evidence before reconciliation updates its reason.
      // Never include the endpoint, credentials, destination, body or raw transport error.
      logger.warn("notification_submission_unconfirmed", {
        businessId: identity, mode, status: result.status, reason: result.reason,
        httpStatus, jsonReceipt, transportFailure
      });
    }
    this.db?.updateNotificationDelivery?.(identity, result);
    const persisted = this.db?.getNotificationDelivery?.(identity);
    if (persisted) return { ...result, ...this.asResult(persisted) };
    return { ...result, ok: ["queued", "sent", "suppressed"].includes(result.status) };
  }

  async reconcilePending() {
    if (this.reconciling || !this.db?.getNotificationReconciliation) return;
    if (!this.config.telegramServiceUrl || !this.config.telegramApiKey) return;
    this.reconciling = true;
    try {
      for (const row of this.db.getNotificationReconciliation(5)) {
        const endpoint = new URL(this.config.telegramServiceUrl);
        endpoint.pathname = row.task_id ? "/message-status" : "/message-receipt";
        endpoint.search = new URLSearchParams(row.task_id ? { taskId: row.task_id } : { idempotencyKey: row.idempotency_key }).toString();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        let result;
        try {
          const response = await fetch(endpoint, { headers: { [this.config.telegramApiKeyHeader || "X-API-Key"]: this.config.telegramApiKey }, signal: controller.signal, redirect: "error" });
          if (!response.ok) result = { status: "unknown", reason: response.status === 404 ? "receipt_unavailable" : "receipt_query_unavailable" };
          else {
            const body = await response.json().catch(() => null);
            const sameIdentity = row.task_id ? body?.taskId === row.task_id : body?.idempotencyKey === row.idempotency_key;
            result = sameIdentity ? this.parseReceipt(body, true, "relay")
              : { status: "unknown", reason: "receipt_identity_mismatch" };
          }
        } catch {
          result = { status: "unknown", reason: "receipt_query_unavailable" };
        } finally { clearTimeout(timer); }
        this.db.updateNotificationDelivery(row.business_id, result);
      }
    } finally { this.reconciling = false; }
  }
}
