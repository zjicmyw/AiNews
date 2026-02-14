import { clamp } from "./utils.js";

function scoreSourceCredibility(event) {
  const sourceType = String(event.source_type || "").toLowerCase();
  const source = String(event.source || "").toLowerCase();

  if (sourceType === "x") return 75;
  if (sourceType === "gdelt") return 70;

  const officialHints = ["federalreserve", "ecb", ".gov", "imf", "worldbank", "treasury"];
  if (officialHints.some((hint) => source.includes(hint))) return 95;

  const tier1Hints = ["reuters", "bloomberg", "wsj", "ft.com", "cnbc"];
  if (tier1Hints.some((hint) => source.includes(hint))) return 85;

  return 68;
}

export class RiskEngine {
  constructor(config, db) {
    this.config = config;
    this.db = db;
  }

  computeLevel(riskScore, marketConfirmation, isDataAnomaly, thresholds = {}) {
    const level2Threshold = Number.isFinite(thresholds.level2Threshold)
      ? thresholds.level2Threshold
      : this.config.level2Threshold;
    const level3Threshold = Number.isFinite(thresholds.level3Threshold)
      ? thresholds.level3Threshold
      : this.config.level3Threshold;
    if (!Number.isFinite(riskScore)) return 0;
    if (riskScore >= level3Threshold && marketConfirmation >= this.config.marketConfirmStrong && !isDataAnomaly) {
      return 3;
    }
    if (riskScore >= level2Threshold) return 2;
    if (riskScore >= 40) return 1;
    return 0;
  }

  computeRegimeProbability(riskScore, marketConfirmation, isDataAnomaly) {
    const raw = Math.round(0.55 * riskScore + 0.45 * marketConfirmation);
    const clamped = clamp(raw, 0, 100);
    if (isDataAnomaly) return Math.min(clamped, 69);
    return clamped;
  }

  probabilityToRegime(probability) {
    if (probability >= 70) return "Risk-Off";
    if (probability >= 40) return "Neutral";
    return "Risk-On";
  }

  buildPushDecision({ event, level, isDataAnomaly, dedupKey }) {
    if (level < 2) {
      return { pushAllowed: false, pushReason: "level_below_2" };
    }

    if (!this.db.canPushByDedup(dedupKey, this.config.dedupWindowMin)) {
      return { pushAllowed: false, pushReason: "dedup_window_block" };
    }

    if (level === 2 && !this.db.canPushLevel2ByCooldown(this.config.level2CooldownMin)) {
      return { pushAllowed: false, pushReason: "level2_cooldown_block" };
    }

    if (level === 3) {
      if (isDataAnomaly) {
        return { pushAllowed: false, pushReason: "fail_closed_market_anomaly" };
      }
      if (!this.db.canPushLevel3ByDailyLimit(this.config.level3DailyLimit)) {
        return { pushAllowed: false, pushReason: "level3_daily_limit_block" };
      }
    }

    if (!this.config.telegramEnabled) {
      return { pushAllowed: false, pushReason: "telegram_disabled" };
    }

    const mode = this.config.telegramMode === "direct" ? "direct" : "relay";
    if (mode === "relay") {
      if (!this.config.telegramServiceUrl || !this.config.telegramApiKey || !this.config.telegramChatId) {
        return { pushAllowed: false, pushReason: "telegram_relay_not_configured" };
      }
    } else if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      return { pushAllowed: false, pushReason: "telegram_direct_not_configured" };
    }

    return { pushAllowed: true, pushReason: "ok" };
  }

  evaluate({ event, analysis, marketSnapshot, dedupKey }) {
    const sourceCredibility = scoreSourceCredibility(event);
    const newsSeverity = clamp(Number(analysis.news_severity || 0), 0, 100);
    const assetRelevance = clamp(Number(analysis.asset_relevance || 0), 0, 100);
    const marketConfirmation = clamp(Number(marketSnapshot.confirmation_score || 0), 0, 100);

    const sourceType = String(event?.source_type || "").toLowerCase();
    const level2Lower = sourceType === "x" ? Math.max(0, this.config.xLevel2ThresholdLowerForX || 0) : 0;
    const effectiveLevel2Threshold = Math.max(0, this.config.level2Threshold - level2Lower);

    const riskScore = clamp(
      newsSeverity * 0.3 + assetRelevance * 0.15 + marketConfirmation * 0.4 + sourceCredibility * 0.15,
      0,
      100
    );

    const wouldBeLevel3 =
      riskScore >= this.config.level3Threshold && marketConfirmation >= this.config.marketConfirmStrong;
    const degradedFromLevel3 = wouldBeLevel3 && marketSnapshot.is_data_anomaly;
    const level = this.computeLevel(riskScore, marketConfirmation, marketSnapshot.is_data_anomaly, {
      level2Threshold: effectiveLevel2Threshold,
      level3Threshold: this.config.level3Threshold
    });
    const regimeProbability = this.computeRegimeProbability(riskScore, marketConfirmation, marketSnapshot.is_data_anomaly);
    const regime = this.probabilityToRegime(regimeProbability);

    const decisionReasons = [
      ...analysis.reasons.slice(0, 3),
      ...marketSnapshot.confirmation_reasons.slice(0, 2),
      ...marketSnapshot.anomaly_reasons.slice(0, 2)
    ].filter(Boolean);

    const pushDecision = this.buildPushDecision({
      event,
      level,
      isDataAnomaly: marketSnapshot.is_data_anomaly,
      dedupKey
    });

    return {
      risk_score: Number(riskScore.toFixed(2)),
      level,
      would_be_level3: wouldBeLevel3,
      degraded_from_level3: degradedFromLevel3,
      regime,
      regime_probability: regimeProbability,
      market_confirmation: Number(marketConfirmation.toFixed(2)),
      news_severity: Number(newsSeverity.toFixed(2)),
      asset_relevance: Number(assetRelevance.toFixed(2)),
      source_credibility: Number(sourceCredibility.toFixed(2)),
      is_data_anomaly: marketSnapshot.is_data_anomaly,
      decision_reasons: decisionReasons,
      push_allowed: pushDecision.pushAllowed,
      push_reason: pushDecision.pushReason
    };
  }
}
