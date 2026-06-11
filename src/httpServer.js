import express from "express";
import { logger } from "./logger.js";
import { buildCexCoverage } from "./opportunityAnalytics.js";
import { parseMaxApyPercent } from "./opportunityUtils.js";

const OPPORTUNITY_TYPE_LABELS = {
  stablecoin_earn: "稳定币理财",
  launch: "打新",
  pre_ipo: "Pre-IPO",
  short_term: "短期临时",
  onchain: "链上/DEX"
};

const DEADLINE_SOURCE_LABELS = {
  official_page: "官方公告确认",
  x_post: "X 原帖确认",
  xintel: "xintel 提取",
  grok: "Grok 补查",
  no_fixed_deadline: "无固定截止",
  unverified: "待确认"
};

function groupOpportunities(rows) {
  const bySection = { cex: [], onchain: [] };
  const byType = {
    stablecoin_earn: [],
    launch: [],
    pre_ipo: [],
    short_term: [],
    onchain: []
  };

  for (const row of rows) {
    const section = row.section === "onchain" ? "onchain" : "cex";
    bySection[section].push(row);
    const type = byType[row.type] ? row.type : section === "onchain" ? "onchain" : "short_term";
    byType[type].push(row);
  }

  return { bySection, byType };
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function buildOpportunitiesCsv(items) {
  const columns = [
    ["活动名称", (item) => item.activity_name],
    ["类型", (item) => OPPORTUNITY_TYPE_LABELS[item.type] || item.type],
    ["状态", (item) => item.review?.label || item.status],
    ["交易所/项目", (item) => item.exchange || item.venue],
    ["分区", (item) => (item.section === "onchain" ? "链上/DEX" : "CEX")],
    ["币种", (item) => item.asset],
    ["稳定币", (item) => item.stablecoin],
    ["APY", (item) => item.apy],
    ["最高APY", (item) => item.yield_profile?.max_apy ?? item.apy],
    ["入库/常规APY", (item) => item.yield_profile?.base_apy ?? item.apy],
    ["收益性质", (item) => item.yield_profile?.summary],
    ["收益条件", (item) => (item.yield_profile?.qualifiers || []).join("、")],
    ["收益/奖励", (item) => item.reward || item.expected_yield],
    ["期限", (item) => item.duration],
    ["截止时间", (item) => item.deadline_at],
    ["截止来源", (item) => DEADLINE_SOURCE_LABELS[item.deadline_source] || item.deadline_source],
    ["参与方式", (item) => item.participation],
    ["参与指引", (item) => item.participation_guidance?.text],
    ["来源账号", (item) => item.source_user],
    ["来源链接", (item) => item.source_url],
    ["官方链接", (item) => item.official_url],
    ["来源可信度", (item) => item.credibility],
    ["风险等级", (item) => item.risk_profile?.level],
    ["风险提示", (item) => item.risk_note],
    ["新鲜度", (item) => item.freshness?.label],
    ["来源发布时间", (item) => item.source_published_at],
    ["首次发现", (item) => item.first_seen_at],
    ["最近采集", (item) => item.last_seen_at]
  ];
  return [
    columns.map(([label]) => csvEscape(label)).join(","),
    ...items.map((item) => columns.map(([, pick]) => csvEscape(pick(item))).join(","))
  ].join("\n");
}

function buildStablecoinSummary(items) {
  const rows = items.filter((item) => item.type === "stablecoin_earn" && item.status !== "unverified");
  const byCoin = {};
  const bySection = { cex: 0, onchain: 0 };
  let highest = null;

  for (const item of rows) {
    const coin = String(item.stablecoin || item.asset || "UNKNOWN").toUpperCase();
    byCoin[coin] = (byCoin[coin] || 0) + 1;
    const section = item.section === "onchain" ? "onchain" : "cex";
    bySection[section] = (bySection[section] || 0) + 1;
    const apy = Number.isFinite(Number(item.yield_profile?.max_apy))
      ? Number(item.yield_profile.max_apy)
      : Number(item.apy || 0);
    if (!highest || apy > Number(highest.apy || 0)) {
      const baseApy = Number.isFinite(Number(item.apy)) ? Number(item.apy) : null;
      const isPromotionalHigh = Number.isFinite(apy) && Number.isFinite(baseApy) && apy > baseApy;
      highest = {
        activity_name: item.activity_name,
        exchange: item.exchange || "",
        venue: item.venue || "",
        stablecoin: coin,
        apy: Number.isFinite(apy) ? apy : null,
        base_apy: baseApy,
        apy_source: item.yield_profile?.max_apy_source || "stored",
        yield_summary: item.yield_profile?.summary || "",
        condition_tags: item.yield_profile?.qualifiers || [],
        is_promotional_high: isPromotionalHigh,
        duration: item.duration || "",
        deadline_at: item.deadline_at || null,
        deadline_source: item.deadline_source || null,
        source_url: item.source_url || "",
        official_url: item.official_url || "",
        review_label: item.review?.label || ""
      };
    }
  }

  return {
    total: rows.length,
    cex_total: bySection.cex || 0,
    onchain_total: bySection.onchain || 0,
    by_coin: byCoin,
    highest
  };
}

function opportunityGapKey(item) {
  return item.dedup_key || item.source_url || [item.exchange, item.venue, item.activity_name].filter(Boolean).join("|");
}

function opportunityGapPriority(item) {
  let score = 0;
  if (item.status === "active") score += 30;
  if (item.type === "stablecoin_earn") score += 25;
  if (item.type === "pre_ipo") score += 20;
  if (item.type === "launch") score += 15;
  if (item.section === "cex") score += 10;
  if (item.source_url) score += 5;
  if (item.credibility === "official") score += 5;
  if (Number.isFinite(Number(item.apy))) score += Math.min(10, Number(item.apy) / 5);
  return score;
}

function buildFieldGapExample(item) {
  return {
    activity_name: item.activity_name,
    type: item.type,
    section: item.section,
    exchange: item.exchange || "",
    venue: item.venue || "",
    stablecoin: item.stablecoin || "",
    asset: item.asset || "",
    apy: item.apy ?? null,
    status: item.status,
    review_label: item.review?.label || item.status,
    source_user: item.source_user || "",
    source_url: item.source_url || "",
    official_url: item.official_url || "",
    missing: item.data_quality?.missing || []
  };
}

function buildOpportunityFieldGaps(items) {
  const gapDefs = [
    {
      key: "deadline",
      label: "缺截止时间",
      description: "没有明确截止时间，也未被确认是无固定截止。优先用官方公告或 Grok 补查。",
      predicate: (item) => !item.deadline_at && item.deadline_source !== "no_fixed_deadline"
    },
    {
      key: "official_url",
      label: "缺官方入口",
      description: "只有 X 来源或摘要，缺少交易所公告、活动页或 DApp 官方入口。",
      predicate: (item) => !item.official_url
    },
    {
      key: "participation",
      label: "缺参与方式",
      description: "缺少具体入口、认购/质押/交易步骤，页面中只能提示先打开来源核验。",
      predicate: (item) => !item.participation
    },
    {
      key: "source_url",
      label: "缺来源链接",
      description: "xintel 返回了机会摘要，但没有可追踪 X 帖链接。",
      predicate: (item) => !item.source_url
    },
    {
      key: "unverified",
      label: "待核验",
      description: "关键字段不足或来源可信度不够，默认不混入 active 列表。",
      predicate: (item) => item.status === "unverified"
    }
  ];
  const itemKeysWithGap = new Set();
  const fields = gapDefs.map((def) => {
    const rows = items
      .filter(def.predicate)
      .sort((a, b) => opportunityGapPriority(b) - opportunityGapPriority(a));
    for (const row of rows) itemKeysWithGap.add(opportunityGapKey(row));
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      count: rows.length,
      examples: rows.slice(0, 5).map(buildFieldGapExample)
    };
  });

  return {
    total_items: items.length,
    total_items_with_gap: itemKeysWithGap.size,
    fields
  };
}

function isOpportunityEnrichmentCandidate(item = {}) {
  const status = String(item.status || "").toLowerCase();
  if (!["active", "unverified"].includes(status)) return false;
  if (item.deadline_source === "no_fixed_deadline") return false;
  return !item.deadline_at || !item.deadline_source || !item.official_url;
}

function buildOpportunityEnrichmentReasons(item = {}) {
  const reasons = [];
  if (!item.deadline_at && item.deadline_source !== "no_fixed_deadline") reasons.push("缺截止时间");
  if (item.deadline_at && !item.deadline_source) reasons.push("缺截止来源");
  if (!item.official_url) reasons.push("缺官方入口");
  if (item.official_url && item.official_url_source === "official_product" && !item.deadline_at) {
    reasons.push("只有产品页，待找公告页");
  }
  if (!item.source_url) reasons.push("缺来源链接");
  if (item.enrichment_error) reasons.push("上次补查失败");
  return [...new Set(reasons)];
}

function nextEnrichmentRetryAt(item = {}, cooldownHours = 12) {
  const enrichedMs = Date.parse(item.enriched_at || "");
  if (!Number.isFinite(enrichedMs)) return null;
  return new Date(enrichedMs + Math.max(0, Number(cooldownHours || 0)) * 60 * 60 * 1000).toISOString();
}

function buildOpportunityEnrichmentExample(item = {}, cooldownHours = 12) {
  return {
    dedup_key: item.dedup_key || "",
    activity_name: item.activity_name || "",
    type: item.type || "",
    section: item.section || "",
    exchange: item.exchange || "",
    venue: item.venue || "",
    stablecoin: item.stablecoin || "",
    asset: item.asset || "",
    apy: item.apy ?? null,
    status: item.status || "",
    review_label: item.review?.label || item.status || "",
    source_user: item.source_user || "",
    source_url: item.source_url || "",
    official_url: item.official_url || "",
    official_url_source: item.official_url_source || "",
    deadline_at: item.deadline_at || null,
    deadline_source: item.deadline_source || null,
    deadline_text: item.deadline_text || "",
    enriched_at: item.enriched_at || null,
    retry_after_at: nextEnrichmentRetryAt(item, cooldownHours),
    enrichment_error: item.enrichment_error || "",
    reasons: buildOpportunityEnrichmentReasons(item)
  };
}

function buildOpportunityEnrichmentBacklog(db, config, items) {
  const enabled = config?.opportunityEnrichmentEnabled !== false;
  const retryLimit = Math.max(1, Number(config?.opportunityExistingEnrichmentMaxItems || 2));
  const cooldownHours = Math.max(0, Number(config?.opportunityEnrichmentRetryCooldownHours || 12));
  const nowMs = Date.now();
  const byKey = new Map(items.map((item) => [opportunityGapKey(item), item]));
  let readyRows = [];

  if (enabled && db.getOpportunityDeadlineEnrichmentCandidates) {
    try {
      readyRows = db.getOpportunityDeadlineEnrichmentCandidates(10, cooldownHours) || [];
    } catch (error) {
      logger.warn("opportunity_enrichment_backlog_failed", { error: String(error.message || error) });
    }
  }

  const ready = readyRows
    .map((row) => byKey.get(opportunityGapKey(row)) || row)
    .map((row) => buildOpportunityEnrichmentExample(row, cooldownHours));
  const readyKeys = new Set(readyRows.map(opportunityGapKey));
  const displayCandidates = items.filter(isOpportunityEnrichmentCandidate);
  const waitingCooldown = [];
  const queuedOverflow = [];

  for (const item of displayCandidates) {
    const key = opportunityGapKey(item);
    if (readyKeys.has(key)) continue;
    const retryAtMs = Date.parse(nextEnrichmentRetryAt(item, cooldownHours) || "");
    if (Number.isFinite(retryAtMs) && retryAtMs > nowMs) {
      waitingCooldown.push(item);
    } else {
      queuedOverflow.push(item);
    }
  }

  const candidateKeys = new Set([
    ...readyRows.map(opportunityGapKey),
    ...displayCandidates.map(opportunityGapKey)
  ]);

  return {
    enabled,
    retry_limit: retryLimit,
    cooldown_hours: cooldownHours,
    total_candidates: candidateKeys.size,
    ready_count: ready.length,
    waiting_cooldown_count: waitingCooldown.length,
    queued_overflow_count: queuedOverflow.length,
    ready: ready.slice(0, 5),
    waiting_cooldown: waitingCooldown.slice(0, 5).map((item) => buildOpportunityEnrichmentExample(item, cooldownHours)),
    queued_overflow: queuedOverflow.slice(0, 5).map((item) => buildOpportunityEnrichmentExample(item, cooldownHours))
  };
}

function diagnosticTone(severity) {
  return {
    critical: "risk",
    high: "risk",
    medium: "warn",
    low: "info",
    good: "apy"
  }[severity] || "info";
}

function addDiagnosticIssue(issues, { key, severity = "medium", title, detail, action }) {
  issues.push({
    key,
    severity,
    tone: diagnosticTone(severity),
    title,
    detail,
    action
  });
}

function runHealthDetail(runHealth) {
  const summary = String(runHealth?.summary || "").trim();
  const label = String(runHealth?.label || "").trim();
  if (!summary || !label) return summary;
  const prefix = `${label}：`;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

function buildJobFilterSummary(jobStats = []) {
  const reasonMap = new Map();
  const totals = {
    candidate_count: 0,
    normalized_count: 0,
    saved_count: 0,
    drop_count: 0,
    duplicate_count: 0
  };
  const jobsWithDrops = [];

  for (const job of Array.isArray(jobStats) ? jobStats : []) {
    totals.candidate_count += Number(job.candidate_count || 0);
    totals.normalized_count += Number(job.normalized_count || 0);
    totals.saved_count += Number(job.saved_count || 0);
    totals.drop_count += Number(job.drop_count || 0);
    totals.duplicate_count += Number(job.duplicate_count || 0);
    if (Number(job.drop_count || 0) > 0) {
      jobsWithDrops.push({
        name: job.name || "",
        label: job.label || job.name || "未知任务",
        drop_count: Number(job.drop_count || 0),
        top_reason: job.drop_reasons?.[0] || null
      });
    }
    for (const reason of job.drop_reasons || []) {
      const key = reason.reason || reason.label || "unknown";
      const existing = reasonMap.get(key) || {
        reason: key,
        label: reason.label || key,
        count: 0,
        examples: []
      };
      existing.count += Number(reason.count || 0);
      for (const example of reason.examples || []) {
        if (existing.examples.length >= 5) break;
        if (!existing.examples.includes(example)) existing.examples.push(example);
      }
      reasonMap.set(key, existing);
    }
  }

  const topReasons = Array.from(reasonMap.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
  return {
    ...totals,
    pass_ratio: totals.candidate_count ? Number((totals.normalized_count / totals.candidate_count).toFixed(2)) : null,
    top_reasons: topReasons,
    jobs_with_drops: jobsWithDrops.sort((a, b) => b.drop_count - a.drop_count)
  };
}

function buildOpportunityDiagnostics({
  items = [],
  coverage,
  fieldGaps,
  stablecoinSummary,
  runHealth,
  recentRuns = [],
  queryPlan = {},
  latestRun = {}
}) {
  const issues = [];
  const actionItems = [];
  const strengths = [];
  const latestIssues = runHealth?.issues || [];
  const partialRuns = recentRuns.filter((run) => run.run_health?.partial || run.status === "partial").length;
  const failedRuns = recentRuns.filter((run) => run.run_health?.status === "error" || run.status === "error").length;
  const coverageSummary = coverage?.summary || {};
  const coverageRatio = Number(coverageSummary.coverage_ratio || 0);
  const fieldGapFields = fieldGaps?.fields || [];
  const fieldGapTotal = Number(fieldGaps?.total_items_with_gap || 0);
  const stablecoinTotal = Number(stablecoinSummary?.total || 0);
  const onchainTotal = items.filter((item) => item.section === "onchain").length;
  const adaptedJobs = new Set((queryPlan?.adaptations || []).map((adaptation) => adaptation.affected_job).filter(Boolean));
  const filterSummary = buildJobFilterSummary(latestRun?.job_stats || []);

  if (runHealth?.status === "error") {
    addDiagnosticIssue(issues, {
      key: "run_error",
      severity: "critical",
      title: "最近一轮采集失败",
      detail: runHealthDetail(runHealth) || "xintel/Hermes 调用失败，页面正在显示旧数据。",
      action: "优先重试失败任务，必要时继续拆小查询。"
    });
  } else if (runHealth?.partial) {
    addDiagnosticIssue(issues, {
      key: "run_partial",
      severity: "medium",
      title: "最近一轮部分成功",
      detail: runHealthDetail(runHealth) || "部分查询失败或超时，已保留成功子任务结果。",
      action: "优先重试失败子任务，不要直接放大单条查询。"
    });
  } else if (runHealth?.ok) {
    strengths.push({ key: "run_ok", title: "最近一轮采集成功", detail: `保存 ${runHealth.item_count || 0} 条机会。` });
  }

  if (partialRuns + failedRuns >= 2) {
    addDiagnosticIssue(issues, {
      key: "run_stability",
      severity: failedRuns ? "high" : "medium",
      title: "近期采集不稳定",
      detail: `最近 ${recentRuns.length} 轮里有 ${partialRuns} 轮部分成功、${failedRuns} 轮失败。`,
      action: "降低单轮任务复杂度，优先执行覆盖缺口补查和失败任务重试。"
    });
  }

  for (const issue of latestIssues.slice(0, 3)) {
    if (adaptedJobs.has(issue.job)) {
      actionItems.push({
        key: `adapted_${issue.job || "unknown"}`,
        priority: "medium",
        tone: "info",
        title: `已降级 ${issue.job_label}`,
        detail: `${issue.label}；下一轮会跳过该大查询，改跑更小的专题任务。`,
        suggested_query: ""
      });
    } else {
      actionItems.push({
        key: `retry_${issue.job || "unknown"}`,
        priority: issue.type === "timeout" ? "high" : "medium",
        tone: issue.type === "timeout" ? "risk" : "warn",
        title: `重试 ${issue.job_label}`,
        detail: issue.label,
        suggested_query: ""
      });
    }
  }

  if (coverageSummary.missing_cells > 0) {
    addDiagnosticIssue(issues, {
      key: "coverage_gap",
      severity: coverageRatio < 0.4 ? "high" : "medium",
      title: "CEX 覆盖仍不完整",
      detail: `${coverageSummary.covered_cells || 0}/${coverageSummary.total_cells || 0} 个交易所类目有符合筛选结果；空白交易所：${(coverageSummary.empty_exchanges || []).join("、") || "无"}。`,
      action: "下一轮优先跑覆盖缺口补查矩阵。"
    });
    for (const gap of (coverage?.gaps || []).slice(0, 5)) {
      actionItems.push({
        key: `coverage_${gap.exchange}_${gap.type}`,
        priority: gap.priority,
        tone: gap.priority === "high" ? "risk" : gap.priority === "medium" ? "warn" : "info",
        title: `补查 ${gap.exchange} · ${gap.label}`,
        detail: gap.reason,
        suggested_query: gap.suggested_query
      });
    }
  } else if (coverageSummary.total_cells) {
    strengths.push({ key: "coverage_full", title: "CEX 覆盖完整", detail: "5 家 CEX 的目标类别均已有符合筛选结果。" });
  }

  if (fieldGapTotal > 0) {
    const topField = [...fieldGapFields].sort((a, b) => b.count - a.count)[0];
    addDiagnosticIssue(issues, {
      key: "field_gap",
      severity: topField?.key === "deadline" ? "high" : "medium",
      title: "部分机会字段仍需补齐",
      detail: `共有 ${fieldGapTotal} 条机会存在关键字段缺口；最多的是${topField?.label || "未知"} ${topField?.count || 0} 条。`,
      action: "优先用官方公告页爬取，其次用 Grok 针对单条机会补查。"
    });
    for (const field of fieldGapFields.filter((field) => field.count > 0).slice(0, 3)) {
      const example = field.examples?.[0];
      actionItems.push({
        key: `field_${field.key}`,
        priority: field.key === "deadline" ? "high" : "medium",
        tone: field.key === "deadline" ? "risk" : "warn",
        title: field.label,
        detail: example
          ? `${example.exchange || example.venue || "未知项目"} · ${example.activity_name}`
          : field.description,
        suggested_query: example?.source_url || example?.official_url || ""
      });
    }
  } else if (items.length) {
    strengths.push({ key: "fields_ok", title: "关键字段完整", detail: "当前展示机会没有截止、官方入口、参与方式或来源链接缺口。" });
  }

  if (filterSummary.drop_count > 0) {
    const topReason = filterSummary.top_reasons[0];
    addDiagnosticIssue(issues, {
      key: "candidate_filtering",
      severity: topReason?.reason === "apy_below_threshold" || topReason?.reason === "outside_lookback" ? "medium" : "low",
      title: "部分候选被筛掉",
      detail: `本轮 ${filterSummary.candidate_count} 个候选里有 ${filterSummary.drop_count} 个未进入列表；主因：${topReason?.label || "未知"} ${topReason?.count || 0} 个。`,
      action: "继续保留严格门槛；若同一原因长期占比高，应收紧对应 xintel 提示词。"
    });
    for (const reason of filterSummary.top_reasons.slice(0, 3)) {
      actionItems.push({
        key: `filter_${reason.reason}`,
        priority: reason.reason === "apy_below_threshold" ? "medium" : "low",
        tone: reason.reason === "apy_below_threshold" ? "warn" : "info",
        title: `减少${reason.label}`,
        detail: `${reason.count} 个候选被过滤；样例：${reason.examples.slice(0, 2).join(" / ") || "无"}`,
        suggested_query: ""
      });
    }
  } else if (filterSummary.candidate_count > 0) {
    strengths.push({
      key: "filters_clean",
      title: "候选过滤干净",
      detail: `本轮 ${filterSummary.candidate_count} 个候选全部通过规范化筛选。`
    });
  }

  if (stablecoinTotal === 0) {
    addDiagnosticIssue(issues, {
      key: "stablecoin_empty",
      severity: "high",
      title: "稳定币理财为空",
      detail: "当前没有 USDT/USDC/USD1 且 APY>=8% 的 active 稳定币机会。",
      action: "下一轮优先跑 CEX 稳定币理财和链上稳定币收益专题。"
    });
    actionItems.push({
      key: "stablecoin_search",
      priority: "high",
      tone: "risk",
      title: "补查稳定币 APY>=8%",
      detail: "覆盖 Binance/OKX/Bybit/Gate/Bitget 与链上 USDT/USDC/USD1。",
      suggested_query: "USDT OR USDC OR USD1 Earn APR APY boosted limited-time >=8"
    });
  } else {
    const highest = stablecoinSummary?.highest;
    strengths.push({
      key: "stablecoin_found",
      title: "稳定币机会已收录",
      detail: highest
        ? `最高 ${highest.exchange || highest.venue || "未知"} ${highest.stablecoin} ${highest.apy}% APY。`
        : `共 ${stablecoinTotal} 条。`
    });
  }

  if (onchainTotal === 0) {
    addDiagnosticIssue(issues, {
      key: "onchain_empty",
      severity: "medium",
      title: "链上/DEX 分区为空",
      detail: "当前没有链上/DEX active 或待核验机会。",
      action: "下一轮跑链上稳定币收益与积分/LP 激励专题。"
    });
  } else {
    strengths.push({ key: "onchain_found", title: "链上分区已收录", detail: `当前有 ${onchainTotal} 条链上/DEX 机会。` });
  }

  const status =
    issues.some((issue) => issue.severity === "critical") || items.length === 0
      ? "critical"
      : issues.some((issue) => issue.severity === "high")
        ? "needs_attention"
        : issues.length
          ? "watch"
          : "healthy";
  const label = {
    critical: "需立即处理",
    needs_attention: "需重点补查",
    watch: "有待优化",
    healthy: "状态良好"
  }[status];
  const score = Math.max(
    0,
    Math.min(
      100,
      100 -
        issues.filter((issue) => issue.severity === "critical").length * 35 -
        issues.filter((issue) => issue.severity === "high").length * 20 -
        issues.filter((issue) => issue.severity === "medium").length * 10 -
        Math.max(0, 1 - coverageRatio) * 20
    )
  );

  return {
    status,
    label,
    score: Math.round(score),
    summary: issues.length
      ? `${label}：${issues.slice(0, 2).map((issue) => issue.title).join("；")}`
      : "状态良好：当前没有关键采集或字段缺口。",
    issues,
    action_items: actionItems.slice(0, 8),
    strengths: strengths.slice(0, 5),
    filter_summary: filterSummary
  };
}

function buildOpportunityQuality(row) {
  const checks = [
    { ok: Boolean(row.source_url), missing: "来源链接" },
    { ok: Boolean(row.source_user), missing: "来源账号" },
    { ok: row.credibility && row.credibility !== "unverified", missing: "来源可信度" },
    { ok: Boolean(row.official_url), missing: "官方入口" },
    {
      ok: Boolean(row.deadline_at) || row.deadline_source === "no_fixed_deadline",
      missing: "截止时间"
    },
    { ok: Boolean(row.participation), missing: "参与方式" },
    { ok: Boolean(row.risk_note), missing: "风险说明" },
    {
      ok: (row.apy !== null && row.apy !== undefined) || Boolean(row.expected_yield || row.reward),
      missing: "收益信息"
    }
  ];

  if (row.section === "cex") {
    checks.push({ ok: Boolean(row.exchange), missing: "交易所" });
  } else {
    checks.push({ ok: Boolean(row.venue), missing: "项目入口" });
  }

  if (row.type === "stablecoin_earn") {
    const stablecoin = String(row.stablecoin || row.asset || "").toUpperCase();
    checks.push({ ok: ["USDT", "USDC", "USD1"].includes(stablecoin), missing: "稳定币币种" });
    checks.push({ ok: Number(row.apy) >= 8, missing: "APY>=8%" });
  }

  const missing = checks.filter((check) => !check.ok).map((check) => check.missing);
  const score = Math.round(((checks.length - missing.length) / checks.length) * 100);
  return {
    score,
    level: score >= 85 ? "high" : score >= 70 ? "medium" : "low",
    missing
  };
}

function buildOpportunityReview(row) {
  const isOngoingCexProduct =
    row.section === "cex" &&
    row.deadline_source === "no_fixed_deadline" &&
    row.official_url_source === "official_product";

  if (isOngoingCexProduct) {
    return {
      label: "观察项",
      tone: "info",
      reason: "持续产品或限池产品，无明确活动截止；参与前核验实时额度、APR、合约状态和地区资格。"
    };
  }

  if (row.status === "unverified") {
    const missing = [];
    if (!row.deadline_at && row.deadline_source !== "no_fixed_deadline") missing.push("截止时间");
    if (!row.source_published_at) missing.push("发布时间");
    if (row.credibility === "unverified") missing.push("来源可信度");
    return {
      label: "待核验",
      tone: "warn",
      reason: missing.length ? `待核验字段：${missing.join("、")}` : "仍需核验条款细节"
    };
  }

  if (row.status === "expired") {
    return { label: "已过期", tone: "warn", reason: "活动截止时间已过" };
  }

  return { label: "可参与", tone: "apy", reason: "字段较完整，但参与前仍需按官方来源复核条款" };
}

function buildOpportunityUrgency(row, now = new Date()) {
  if (row.deadline_source === "no_fixed_deadline") {
    return { label: "无固定截止", level: "watch", hours_left: null };
  }
  const deadlineMs = Date.parse(row.deadline_at || "");
  if (!Number.isFinite(deadlineMs)) {
    return { label: "待确认", level: "pending", hours_left: null };
  }
  const hoursLeft = Math.round((deadlineMs - now.getTime()) / 36_000) / 100;
  if (hoursLeft < 0) return { label: "已过期", level: "expired", hours_left: hoursLeft };
  if (hoursLeft <= 48) return { label: "48小时内截止", level: "urgent", hours_left: hoursLeft };
  if (hoursLeft <= 168) return { label: "7天内截止", level: "soon", hours_left: hoursLeft };
  return { label: "进行中", level: "normal", hours_left: hoursLeft };
}

function parseTimeMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function buildOpportunityFreshness(row, now = new Date()) {
  const nowMs = now.getTime();
  const candidates = [
    { value: row.source_published_at, basis: "source_published_at", basis_label: "来源发布" },
    { value: row.first_seen_at, basis: "first_seen_at", basis_label: "首次发现" },
    { value: row.last_seen_at, basis: "last_seen_at", basis_label: "最近采集" }
  ]
    .map((candidate) => ({ ...candidate, ms: parseTimeMs(candidate.value) }))
    .find((candidate) => candidate.ms !== null);

  if (!candidates || !Number.isFinite(nowMs)) {
    return {
      label: "时间未知",
      level: "unknown",
      age_hours: null,
      basis: "unknown",
      basis_label: "时间未知"
    };
  }

  const ageHours = Math.max(0, Math.round(((nowMs - candidates.ms) / 36_000) / 100));
  if (ageHours <= 6) {
    return { label: "6小时内新帖", level: "new", age_hours: ageHours, basis: candidates.basis, basis_label: candidates.basis_label };
  }
  if (ageHours <= 24) {
    return { label: "24小时内", level: "recent_24", age_hours: ageHours, basis: candidates.basis, basis_label: candidates.basis_label };
  }
  if (ageHours <= 72) {
    return { label: "72小时内", level: "recent_72", age_hours: ageHours, basis: candidates.basis, basis_label: candidates.basis_label };
  }
  if (ageHours <= 96) {
    return { label: "96小时内待复查", level: "stale_96", age_hours: ageHours, basis: candidates.basis, basis_label: candidates.basis_label };
  }
  return { label: "旧帖待复查", level: "stale", age_hours: ageHours, basis: candidates.basis, basis_label: candidates.basis_label };
}

const RUN_JOB_LABELS = {
  main: "主查询",
  gate_spacex: "Gate/SpaceX 专题",
  cex_coverage_gaps: "CEX 覆盖缺口补查",
  cex_pre_ipo: "CEX Pre-IPO 专题",
  cex_launch: "CEX 打新专题",
  cex_stablecoin_earn: "CEX 稳定币理财专题",
  cex_short_term: "CEX 短期活动专题",
  onchain_stablecoin: "链上稳定币收益专题",
  onchain_points_lp: "链上积分/LP 专题",
  onchain: "链上/DEX 专题"
};

function parseRunIssue(rawIssue) {
  const text = String(rawIssue || "").trim();
  if (!text) return null;

  const [jobRaw, ...detailParts] = text.split(":");
  const job = detailParts.length ? jobRaw : "unknown";
  const detail = detailParts.length ? detailParts.join(":") : text;
  const timeoutMatch = detail.match(/hermes_timeout_after_(\d+)ms/i);
  if (timeoutMatch) {
    const seconds = Math.round(Number(timeoutMatch[1]) / 1000);
    return {
      job,
      job_label: RUN_JOB_LABELS[job] || job,
      type: "timeout",
      label: `${seconds} 秒超时`,
      detail
    };
  }
  if (detail.includes("xintel_parse_failed")) {
    return {
      job,
      job_label: RUN_JOB_LABELS[job] || job,
      type: "parse_failed",
      label: "xintel 返回解析失败",
      detail
    };
  }
  if (detail.includes("xintel_no_candidates")) {
    return {
      job,
      job_label: RUN_JOB_LABELS[job] || job,
      type: "no_candidates",
      label: "未找到候选机会",
      detail
    };
  }
  if (detail.includes("hermes_failed")) {
    return {
      job,
      job_label: RUN_JOB_LABELS[job] || job,
      type: "hermes_failed",
      label: "Hermes 调用失败",
      detail
    };
  }
  return {
    job,
    job_label: RUN_JOB_LABELS[job] || job,
    type: "unknown",
    label: detail,
    detail
  };
}

function buildOpportunityRunHealth(run = {}, monitor = {}) {
  const running = Boolean(monitor?.running);
  const rawStatus = running ? "running" : String(run?.status || "").toLowerCase();
  const status = rawStatus || "idle";
  const labels = {
    ok: "成功",
    partial: "部分成功",
    error: "失败",
    running: "采集中",
    idle: "待机"
  };
  const errorText = String(run?.error || monitor?.last_error || "").trim();
  const issues = errorText
    ? errorText.split(";").map(parseRunIssue).filter(Boolean)
    : [];
  const itemCount = Number(run?.item_count || 0);
  const failedJobs = issues.map((issue) => `${issue.job_label}：${issue.label}`);
  let summary = labels[status] || status;
  if (status === "partial") {
    summary = `部分成功：已保存 ${itemCount} 条，${issues.length} 个查询需复查`;
  } else if (status === "error" && issues.length) {
    summary = `失败：${failedJobs.slice(0, 2).join("；")}`;
  } else if (running) {
    summary = "采集中，本轮完成前继续显示旧数据";
  }

  return {
    status,
    label: labels[status] || status,
    ok: status === "ok",
    partial: status === "partial",
    running,
    item_count: itemCount,
    duration_ms: Number.isFinite(Number(run?.duration_ms)) ? Number(run.duration_ms) : null,
    issue_count: issues.length,
    issues,
    summary
  };
}

function inferJobType(job = "") {
  if (job === "cex_coverage_gaps") return "coverage_gap";
  if (String(job).startsWith("onchain")) return "onchain";
  return "cex";
}

function buildFallbackJobStats(run = {}, runHealth = {}) {
  const existing = Array.isArray(run.job_stats) ? run.job_stats : [];
  if (existing.length) return existing;
  const issues = runHealth.issues || [];
  if (!issues.length) return [];
  return issues.map((issue) => {
    const timeoutMatch = String(issue.detail || "").match(/hermes_timeout_after_(\d+)ms/i);
    return {
      name: issue.job || "unknown",
      label: issue.job_label || issue.job || "未知任务",
      type: inferJobType(issue.job),
      status: issue.type === "parse_failed" ? "parse_failed" : "error",
      duration_ms: timeoutMatch ? Number(timeoutMatch[1]) : null,
      raw_length: 0,
      candidate_count: 0,
      normalized_count: 0,
      saved_count: 0,
      error: issue.detail || issue.label || "",
      fallback: true
    };
  });
}

function getOpportunityRunsWithHealth(db, monitor, limit = 5) {
  const rows = db.getOpportunityRuns?.(limit) || [];
  return rows.map((row, index) => {
    const runHealth = buildOpportunityRunHealth(row, index === 0 ? monitor : { running: false });
    return {
      ...row,
      job_stats: buildFallbackJobStats(row, runHealth),
      run_health: runHealth
    };
  });
}

function decorateOpportunityRun(row, monitor = {}) {
  if (!row) return null;
  const runHealth = buildOpportunityRunHealth(row, monitor);
  return {
    ...row,
    job_stats: buildFallbackJobStats(row, runHealth)
  };
}

function stripRunHealth(row) {
  if (!row) return null;
  const { run_health: _runHealth, ...rest } = row;
  return rest;
}

function buildOpportunityRisk(row) {
  const text = `${row.type || ""} ${row.section || ""} ${row.risk_note || ""} ${row.participation || ""}`.toLowerCase();
  const reasons = [];
  let score = 1;

  if (row.type === "pre_ipo") {
    score = Math.max(score, 4);
    reasons.push("Pre-IPO/估值与流动性风险");
  }
  if (row.section === "onchain") {
    score = Math.max(score, 4);
    reasons.push("链上合约/流动性风险");
  }
  if (/leverage|perp|perpetual|futures|永续|杠杆|synthetic/.test(text)) {
    score = Math.max(score, 5);
    reasons.push("杠杆或合成合约风险");
  }
  if (/prediction|pnl|leaderboard|trading competition|预测|排行榜|交易/.test(text)) {
    score = Math.max(score, 3);
    reasons.push("交易表现/竞赛规则风险");
  }
  if (/credit|rwa|vault|lp|borrow|lend|信贷|金库|流动性|无常损失/.test(text)) {
    score = Math.max(score, 4);
    reasons.push("RWA/借贷/LP收益风险");
  }
  if (row.type === "stablecoin_earn" && row.section === "cex") {
    score = Math.max(score, 2);
    reasons.push("平台额度、地区和利率变动风险");
  }
  if (row.credibility !== "official") {
    score = Math.max(score, 3);
    reasons.push("来源非官方或需二次核验");
  }

  const label = score >= 5 ? "极高" : score >= 4 ? "高" : score >= 3 ? "中" : "低";
  const tone = score >= 4 ? "risk" : score >= 3 ? "warn" : "info";
  return {
    level: label,
    score,
    tone,
    reasons: [...new Set(reasons)]
  };
}

function participationAssetText(row = {}) {
  return row.stablecoin || row.asset || "对应资产";
}

function buildOpportunityYieldProfile(row = {}) {
  const text = [
    row.activity_name,
    row.type,
    row.section,
    row.expected_yield,
    row.reward,
    row.duration,
    row.participation,
    row.risk_note
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  const qualifiers = [];
  let tone = "apy";
  let label = row.type === "stablecoin_earn" ? "理财收益" : "奖励收益";
  const baseApy = Number.isFinite(Number(row.apy)) ? Number(row.apy) : null;
  const parsedApy = parseMaxApyPercent(row);
  const maxApy = Number.isFinite(parsedApy) ? parsedApy : baseApy;
  const maxApySource = Number.isFinite(parsedApy) && parsedApy !== baseApy ? "text" : "stored";

  if (Number.isFinite(maxApy) && Number.isFinite(baseApy) && maxApy > baseApy) {
    qualifiers.push("最高促销 APY");
    tone = tone === "risk" ? tone : "warn";
  }

  if (/dual investment|shark fin|structured|option|期权|双币|结构化/.test(text)) {
    qualifiers.push("结构化收益");
    tone = "risk";
    label = "结构化收益";
  }
  if (/new user|new users|新户|新用户/.test(text)) {
    qualifiers.push("新户限定");
    tone = tone === "risk" ? tone : "warn";
  }
  if (/boost|boosted|bonus|promotion|promotional|limited-time|campaign|加成|促销|限时/.test(text)) {
    qualifiers.push("促销加成");
    tone = tone === "risk" ? tone : "warn";
  }
  if (/quota|allocation|cap|limited pool|first-come|额度|配额|限额|先到先得/.test(text)) {
    qualifiers.push("额度有限");
    tone = tone === "risk" ? tone : "warn";
  }
  if (/region|regional|eligible|eligibility|jurisdiction|地区|地域|资格/.test(text)) {
    qualifiers.push("地区/资格限制");
    tone = tone === "risk" ? tone : "warn";
  }
  if (/variable|floating|real-time|实时|浮动|可变/.test(text)) {
    qualifiers.push("浮动利率");
    tone = tone === "risk" ? tone : "info";
  }
  if (/fixed|定期|固定/.test(text) && !qualifiers.includes("浮动利率")) {
    qualifiers.push("固定期限");
  }
  if (row.section === "onchain") {
    qualifiers.push("链上收益");
    tone = "risk";
    label = "链上收益";
  }
  if (row.type === "pre_ipo") {
    qualifiers.push("非 APY 收益");
    label = "Pre-IPO 敞口";
    tone = "risk";
  }
  if (row.type === "launch") {
    qualifiers.push("奖励/空投");
    label = "打新奖励";
    tone = tone === "risk" ? tone : "warn";
  }

  const uniqueQualifiers = [...new Set(qualifiers)];
  return {
    label,
    tone,
    base_apy: baseApy,
    max_apy: Number.isFinite(maxApy) ? maxApy : null,
    max_apy_source: maxApySource,
    qualifiers: uniqueQualifiers,
    summary: uniqueQualifiers.length ? `${label}：${uniqueQualifiers.join("、")}` : label
  };
}

function buildOpportunityParticipationGuidance(row = {}) {
  const venue = row.exchange || row.venue || "官方入口";
  const asset = participationAssetText(row);
  const officialUrl = row.official_url || "";
  const sourceUrl = row.source_url || "";
  const primaryUrl = officialUrl || sourceUrl || "";
  const primaryUrlLabel = officialUrl ? "官方入口" : sourceUrl ? "来源帖" : "";
  const hasOriginal = Boolean(row.participation);
  let text = "";
  let steps = [];

  if (row.section === "onchain") {
    text = `进入 ${venue} 官方 DApp，切换到公告指定链，先核验合约、池子 APY、锁仓和赎回规则，再用 ${asset} 小额测试参与。`;
    steps = [
      `打开 ${venue} 官方 DApp 或公告入口`,
      "核验合约地址、链、池子容量、APY 和退出规则",
      `用 ${asset} 小额测试后再决定是否加仓`
    ];
  } else if (row.type === "stablecoin_earn") {
    text = `进入 ${venue} 的 Earn/理财页面，选择 ${asset} 产品，确认 APY、期限、额度、地区资格和赎回规则后认购。`;
    steps = [
      `打开 ${venue} Earn/理财或官方活动页`,
      `选择 ${asset} 产品并核验 APY、期限、额度和地区资格`,
      "确认赎回/锁仓规则后再认购"
    ];
  } else if (row.type === "pre_ipo") {
    text = `进入 ${venue} 的 Pre-IPO/预上市入口，按公告使用 ${asset} 认购或交易，先核验份额性质、锁定/流动性、地区限制和二级市场风险。`;
    steps = [
      `打开 ${venue} Pre-IPO/预上市或官方公告入口`,
      `确认是否用 ${asset} 认购、最低金额、配额和发放/交易时间`,
      "核验锁定、转让、流动性、估值和地区限制后再参与"
    ];
  } else if (row.type === "launch") {
    text = `进入 ${venue} Launchpad/Launchpool/Startup 或任务页，按公告完成报名、质押、交易或任务，确认奖励发放时间。`;
    steps = [
      `打开 ${venue} 打新/Launchpad/Launchpool/任务活动页`,
      "按公告完成报名、质押、交易或任务条件",
      "核验快照、奖励发放时间、资格和地区限制"
    ];
  } else {
    text = `打开 ${venue} 官方活动页，按公告完成交易、报名或任务，确认奖池、排名规则、截止时间和奖励发放方式。`;
    steps = [
      `打开 ${venue} 官方活动页`,
      "按公告完成交易、报名、预测或任务要求",
      "核验奖池、排名规则、截止时间和奖励发放方式"
    ];
  }

  return {
    generated: !hasOriginal,
    text,
    steps,
    primary_url: primaryUrl,
    primary_url_label: primaryUrlLabel,
    official_url: officialUrl,
    source_url: sourceUrl
  };
}

function attachOpportunityQuality(rows, now = new Date()) {
  return rows.map((row) => ({
    ...row,
    data_quality: buildOpportunityQuality(row),
    review: buildOpportunityReview(row),
    urgency: buildOpportunityUrgency(row, now),
    freshness: buildOpportunityFreshness(row, now),
    risk_profile: buildOpportunityRisk(row),
    yield_profile: buildOpportunityYieldProfile(row),
    participation_guidance: buildOpportunityParticipationGuidance(row)
  }));
}

function compareOpportunityDisplay(a, b) {
  const reviewRank = (item) => {
    if (item.review?.label === "可参与") return 0;
    if (item.review?.label === "待核验") return 1;
    if (item.review?.label === "观察项") return 2;
    return 3;
  };
  const urgencyRank = (item) =>
    ({ urgent: 0, soon: 1, normal: 2, pending: 3, watch: 4, expired: 5 })[item.urgency?.level] ?? 6;
  const freshnessRank = (item) =>
    ({ new: 0, recent_24: 1, recent_72: 2, stale_96: 3, stale: 4, unknown: 5 })[item.freshness?.level] ?? 6;
  const typeRank = (item) =>
    ({ stablecoin_earn: 0, pre_ipo: 1, launch: 2, short_term: 3, onchain: 4 })[item.type] ?? 5;
  return (
    reviewRank(a) - reviewRank(b) ||
    urgencyRank(a) - urgencyRank(b) ||
    freshnessRank(a) - freshnessRank(b) ||
    typeRank(a) - typeRank(b) ||
    Number(b.apy || 0) - Number(a.apy || 0) ||
    String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || ""))
  );
}

function getDisplayOpportunityItems(db, config) {
  const rawItems =
    db.getDisplayOpportunities?.(config.opportunityStaleAfterHours) ||
    db.getActiveOpportunities?.(config.opportunityStaleAfterHours) ||
    [];
  return attachOpportunityQuality(rawItems, new Date()).sort(compareOpportunityDisplay);
}

function buildOpportunitiesPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>xintel 高收益机会监控</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f8;
      --panel: #ffffff;
      --text: #17201b;
      --muted: #65716b;
      --line: #dfe5e1;
      --accent: #087f5b;
      --accent-soft: #dff4ea;
      --warn: #9a6700;
      --warn-soft: #fff1c2;
      --risk: #b42318;
      --risk-soft: #ffe4df;
      --info: #255a9b;
      --info-soft: #dbeafe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      letter-spacing: 0;
    }
    header {
      padding: 18px 22px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 700;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: -4px 0 12px;
    }
    .action-link {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 9px;
      background: #fbfcfb;
      color: var(--info);
      font-size: 13px;
      font-weight: 700;
    }
    .status {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      max-width: 1180px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfb;
      padding: 10px 12px;
      min-width: 0;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    .metric strong {
      display: block;
      overflow-wrap: anywhere;
      font-size: 14px;
    }
    main {
      padding: 14px 22px 28px;
    }
    .tabs {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 10px;
      margin-bottom: 4px;
    }
    .coverage {
      margin-bottom: 12px;
      overflow-x: auto;
    }
    .coverage table {
      min-width: 760px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      border-collapse: separate;
      border-spacing: 0;
      overflow: hidden;
    }
    .coverage th,
    .coverage td {
      min-width: 128px;
    }
    .coverage th:first-child,
    .coverage td:first-child {
      min-width: 110px;
      font-weight: 700;
    }
    .coverage-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin: 0 0 8px;
    }
    .coverage-title strong { font-size: 15px; }
    .coverage-cell {
      display: block;
      min-height: 46px;
    }
    .coverage-cell .muted {
      display: block;
      margin-top: 2px;
      font-size: 12px;
    }
    .gap-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .gap-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 9px 10px;
      min-width: 0;
    }
    .gap-item strong {
      display: block;
      margin-bottom: 5px;
      font-size: 13px;
    }
    .gap-item .muted {
      display: block;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.35;
    }
    .tab {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--text);
      padding: 8px 10px;
      min-height: 34px;
      white-space: nowrap;
      cursor: pointer;
    }
    .tab.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: #07563f;
      font-weight: 700;
    }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    table {
      width: 100%;
      min-width: 1060px;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px;
      text-align: left;
      vertical-align: top;
      line-height: 1.35;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      background: #fbfcfb;
    }
    tr:last-child td { border-bottom: 0; }
    a { color: var(--info); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .name { font-weight: 700; min-width: 180px; }
    .muted { color: var(--muted); }
    .tag {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      border-radius: 999px;
      padding: 3px 7px;
      margin: 0 5px 5px 0;
      font-size: 12px;
      line-height: 1.2;
      overflow-wrap: anywhere;
      background: #eef2f0;
      color: #34423b;
    }
    .tag.apy { background: var(--accent-soft); color: #07563f; font-weight: 700; }
    .tag.warn { background: var(--warn-soft); color: var(--warn); }
    .tag.risk { background: var(--risk-soft); color: var(--risk); }
    .tag.info { background: var(--info-soft); color: var(--info); }
    .empty {
      padding: 26px;
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    @media (max-width: 760px) {
      header, main { padding-left: 12px; padding-right: 12px; }
      .status { grid-template-columns: 1fr 1fr; }
      h1 { font-size: 20px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>xintel 高收益机会监控</h1>
    <div class="actions">
      <a class="action-link" href="/api/opportunities/export.csv">导出 CSV</a>
      <a class="action-link" href="/api/opportunities" target="_blank" rel="noreferrer">查看 JSON API</a>
    </div>
    <section class="status">
      <div class="metric"><span>最近采集</span><strong id="lastRun">加载中</strong></div>
      <div class="metric"><span>下次采集</span><strong id="nextRun">加载中</strong></div>
      <div class="metric"><span>采集状态</span><strong id="runStatus">加载中</strong></div>
      <div class="metric"><span>展示机会</span><strong id="totalCount">0</strong></div>
      <div class="metric"><span>CEX覆盖</span><strong id="coverageQuality">加载中</strong></div>
      <div class="metric"><span>下轮查询</span><strong id="queryPlanSummary">加载中</strong></div>
      <div class="metric"><span>稳定币最高</span><strong id="stablecoinTop">加载中</strong></div>
      <div class="metric"><span>新鲜度</span><strong id="freshnessQuality">加载中</strong></div>
      <div class="metric"><span>可参与</span><strong id="actionableCount">加载中</strong></div>
      <div class="metric"><span>截止质量</span><strong id="deadlineQuality">加载中</strong></div>
      <div class="metric"><span>官方链接</span><strong id="officialQuality">加载中</strong></div>
      <div class="metric"><span>资料完整度</span><strong id="dataQuality">加载中</strong></div>
      <div class="metric"><span>待补字段</span><strong id="fieldGapQuality">加载中</strong></div>
      <div class="metric"><span>补查队列</span><strong id="enrichmentBacklogMetric">加载中</strong></div>
      <div class="metric"><span>采集诊断</span><strong id="diagnosticStatus">加载中</strong></div>
      <div class="metric"><span>任务明细</span><strong id="jobStatsSummary">加载中</strong></div>
      <div class="metric"><span>观察项</span><strong id="watchCount">加载中</strong></div>
      <div class="metric"><span>即将截止</span><strong id="urgentCount">加载中</strong></div>
      <div class="metric"><span>高风险</span><strong id="highRiskCount">加载中</strong></div>
    </section>
  </header>
  <main>
    <section id="coverage" class="coverage"></section>
    <section id="queryPlan" class="coverage"></section>
    <section id="stablecoinSummary" class="coverage"></section>
    <section id="runHistory" class="coverage"></section>
    <section id="jobStats" class="coverage"></section>
    <section id="diagnostics" class="coverage"></section>
    <section id="fieldGaps" class="coverage"></section>
    <section id="enrichmentBacklog" class="coverage"></section>
    <nav class="tabs" id="tabs" data-default-excludes-unverified="true"></nav>
    <section id="content" class="table-wrap"></section>
  </main>
  <script>
    const tabDefs = [
      ["all", "全部"],
      ["new", "新发现"],
      ["urgent", "即将截止"],
      ["watch", "观察项"],
      ["high_risk", "高风险"],
      ["unverified", "待核验"],
      ["stablecoin_earn", "稳定币理财"],
      ["launch", "打新"],
      ["pre_ipo", "Pre-IPO"],
      ["short_term", "短期活动"],
      ["onchain", "链上/DEX"]
    ];
    let state = {
      activeTab: "all",
      items: [],
      coverage: null,
      queryPlan: null,
      stablecoinSummary: null,
      recentRuns: [],
      fieldGaps: null,
      enrichmentBacklog: null,
      diagnostics: null,
      latestRun: null,
      runHealth: null,
      monitor: null
    };

    function fmtTime(value) {
      if (!value) return "未知";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString("zh-CN", { hour12: false });
    }

    function formatDuration(ms) {
      const totalSec = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
      const minutes = Math.floor(totalSec / 60);
      const seconds = totalSec % 60;
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const restMinutes = minutes % 60;
        return hours + "小时" + String(restMinutes).padStart(2, "0") + "分";
      }
      return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
    }

    function nextRunText(monitor, plan) {
      if (monitor?.running) return "采集中";
      if (!monitor?.enabled || plan?.enabled === false) return "监控关闭";
      const nextMs = Date.parse(monitor?.next_run_at || "");
      if (!Number.isFinite(nextMs)) return "等待调度";
      const diff = nextMs - Date.now();
      if (diff <= 0) return "即将开始";
      return "还有 " + formatDuration(diff) + " · " + fmtTime(monitor.next_run_at);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[char]);
    }

    function typeLabel(type) {
      return {
        stablecoin_earn: "稳定币理财",
        launch: "打新",
        pre_ipo: "Pre-IPO",
        short_term: "短期临时",
        onchain: "链上/DEX"
      }[type] || type || "其他";
    }

    function statusLabel(value) {
      return {
        active: "可参与",
        unverified: "待核验",
        expired: "已过期"
      }[String(value || "").toLowerCase()] || "待核验";
    }

    function reviewLabel(item) {
      return item.review?.label || statusLabel(item.status);
    }

    function reviewClass(item) {
      const tone = item.review?.tone;
      if (tone === "apy") return "apy";
      if (tone === "info") return "info";
      return item.status === "active" ? "apy" : "warn";
    }

    function credibilityLabel(value) {
      return {
        official: "官方",
        kol: "KOL/社区",
        unverified: "未核验"
      }[String(value || "").toLowerCase()] || "未核验";
    }

    function deadlineSourceLabel(value) {
      return {
        official_page: "官方公告确认",
        x_post: "X 原帖确认",
        xintel: "xintel 提取",
        grok: "Grok 补查",
        no_fixed_deadline: "无固定截止",
        unverified: "待确认"
      }[String(value || "").toLowerCase()] || "待确认";
    }

    function officialUrlLabel(value) {
      return {
        official_page: "官方公告",
        official_product: "官方页面",
        grok: "官方链接",
        xintel: "官方链接"
      }[String(value || "").toLowerCase()] || "官方链接";
    }

    function localizeText(value, fallback) {
      let text = String(value || "").trim();
      if (!text) return fallback;

      const replacements = [
        [/Subscribe with ([A-Z0-9]+) \\(min ~\\$(\\d+)\\), receive tokenized shares tradable on spot after (.+)/gi, "使用 $1 认购（最低约 $2 美元），获得代币化股份，$3 后可在现货市场交易"],
        [/Subscribe Fixed Earn USDC \\(region restricted to EU\\)/gi, "认购 USDC 定期理财（仅限欧盟地区）"],
        [/EU users only; subscribe Bybit EU Fixed\\/Easy Earn USDC via bybit\\.eu earn pages/gi, "仅限欧盟用户；通过 bybit.eu Earn 页面认购 Bybit EU USDC Fixed/Easy Earn"],
        [/EU users only; subscribe Bybit EU Fixed\\/Easy Earn USDC 通过 bybit\\.eu earn pages/gi, "仅限欧盟用户；通过 bybit.eu Earn 页面认购 Bybit EU USDC Fixed/Easy Earn"],
        [/Subscribe USD1 Flexible Products, max 2,000 USD1 limit per tier/gi, "认购 USD1 灵活理财，每档最高 2,000 USD1"],
        [/Subscribe USD1 灵活 Products, max 2,000 USD1 limit per tier/gi, "认购 USD1 灵活理财，每档最高 2,000 USD1"],
        [/Trade equities perps on Binance \\(65% market share reported\\)/gi, "在 Binance 交易股票/Pre-IPO 永续（来源称市场份额 65%）"],
        [/Supply liquidity or borrow against ONyc in OnRe market on Kamino/gi, "在 Kamino 的 OnRe 市场提供流动性，或用 ONyc 抵押借款"],
        [/Trade prediction markets with positive realized PNL on 3\\+ markets/gi, "交易预测市场，并在 3 个以上市场实现正收益"],
        [/Predict matches, earn points, compete/gi, "预测比赛结果，赚取积分并参与排名竞争"],
        [/Pre-IPO products carry high volatility, lockup\\/transfer restrictions, regulatory and valuation risk/gi, "Pre-IPO 产品波动较高，存在锁定/转让限制、监管和估值风险"],
        [/Requires trading activity, leaderboard competition risk/gi, "需要实际交易，存在排行榜竞争和收益不确定风险"],
        [/Prediction accuracy dependent, prize distribution rules/gi, "收益依赖预测准确率，并受奖励分配规则限制"],
        [/Region eligibility, limited quota, high promotional APR may end quickly/gi, "存在地区资格限制，额度有限，促销高 APR 可能很快结束"],
        [/Variable APR, platform risk, terms may change/gi, "浮动 APR，存在平台风险，条款可能变化"],
        [/Synthetic perps, high leverage risk, not direct equity ownership/gi, "合成永续合约，杠杆风险高，不代表直接持有股权"],
        [/Monthly incentives subject to change; no fixed end date; verify live rates on Kamino app/gi, "月度激励可能变化，未注明固定截止时间，需在 Kamino App 核验实时收益率"],
        [/first-come-first-served limited pool; regional EU restriction only; rates promotional and allocation-dependent/gi, "先到先得，额度有限；仅限欧盟地区；收益率为促销利率并受配额影响"],
        [/Pre-IPO allocation \\+ spot trading post-listing/gi, "Pre-IPO 配额，以及上线后的现货交易机会"],
        [/PNL leaderboard share of ([0-9,]+) USDT/gi, "按已实现收益排行榜瓜分 $1 USDT"],
        [/Points \\+ share of up to \\$(\\d+)M MNT/gi, "积分奖励，并瓜分最高约 $1M MNT 奖池"],
        [/Tokenized 1:1 backed shares/gi, "1:1 支持的代币化股份"],
        [/([0-9,]+) USDT prize pool/gi, "$1 USDT 奖池"],
        [/Up to \\$(\\d+)M MNT prize pool/gi, "最高约 $1M MNT 奖池"],
        [/Subscription open until ~(.+)/gi, "认购开放至约 $1"],
        [/~(\\d+) days/gi, "约 $1 天"],
        [/Season 2026/gi, "2026 赛季期间"],
        [/Pre-IPO allocation risk/gi, "Pre-IPO 配额存在估值和分配风险"],
        [/regional restrictions/gi, "地区限制"],
        [/price divergence from eventual IPO/gi, "与最终上市价格可能存在偏差"],
        [/valuation risk/gi, "估值风险"],
        [/liquidity/gi, "流动性风险"],
        [/platform counterparty/gi, "平台对手方风险"],
        [/Check quota and regional limits/gi, "需核验额度和地区限制"],
        [/APY and quota can change/gi, "APY 和额度可能变化"],
        [/verify terms before subscribing/gi, "参与前需核验条款"],
        [/Buy via/gi, "通过以下入口购买："],
        [/Trade perpetual futures on/gi, "在以下平台交易永续合约："],
        [/Via /gi, "通过 "],
        [/Predict & Earn/gi, "预测赚取奖励"],
        [/Prediction platform/gi, "预测平台"],
        [/Fully subscribed/gi, "已全额认购"],
        [/distribution before/gi, "分配时间早于"],
        [/High demand pre-IPO exposure/gi, "高需求 Pre-IPO 敞口"],
        [/Contract size adjustment/gi, "合约乘数调整"],
        [/OpenAI\\/Anthropic pipeline/gi, "OpenAI/Anthropic 后续项目储备"],
        [/Trading points and fee rebate/gi, "交易积分和手续费返还"],
        [/Trading fees \\+ volume incentives/gi, "交易手续费与成交量激励"],
        [/High volume trading opportunity/gi, "高成交量交易机会"],
        [/Fixed high APR/gi, "固定高 APR"],
        [/Limited-time, first-come first-served/gi, "限时，先到先得"],
        [/7-天 \\(new users up to 100% APR\\) \\/ 30-天 \\(existing up to 16% APR\\)/gi, "7 天档（新用户最高 100% APR）/ 30 天档（老用户最高 16% APR）"],
        [/Real-time APR \\+ tiered bonus/gi, "实时 APR + 阶梯奖励"],
        [/ongoing monthly USDC rewards \\(\\$35K total monthly\\)/gi, "持续的月度 USDC 激励（每月合计约 35,000 USDC）"],
        [/Ongoing since May launch/gi, "5 月上线后持续"],
        [/June/gi, "6月"],
        [/May/gi, "5月"],
        [/Points boost/gi, "积分加成"],
        [/Flexible/gi, "灵活"],
        [/monthly/gi, "按月"],
        [/hours?/gi, "小时"],
        [/days?/gi, "天"],
        [/7-天 \\(new users up to 100% APR\\) \\/ 30-天 \\(existing up to 16% APR\\)/gi, "7 天档（新用户最高 100% APR）/ 30 天档（老用户最高 16% APR）"]
      ];

      for (const [pattern, replacement] of replacements) {
        text = text.replace(pattern, replacement);
      }
      return text;
    }

    function participationText(item) {
      return localizeText(item.participation, item.participation_guidance?.text || "查看来源帖，按官方入口参与");
    }

    function participationHtml(item) {
      const guidance = item.participation_guidance || {};
      const text = escapeHtml(participationText(item));
      const steps = Array.isArray(guidance.steps) ? guidance.steps : [];
      const stepHtml = steps.length
        ? '<br><span class="muted">步骤：' + escapeHtml(steps.map((step, index) => (index + 1) + ". " + step).join("；")) + '</span>'
        : "";
      const guidanceNote = item.participation
        ? '<br><span class="muted">核验：' + escapeHtml(guidance.text || "参与前核验官方条款、额度和截止时间。") + '</span>'
        : "";
      const links = [];
      if (item.official_url) {
        links.push('<a href="' + escapeHtml(item.official_url) + '" target="_blank" rel="noreferrer">打开官方入口参与</a>');
      }
      if (item.source_url && item.source_url !== item.official_url) {
        links.push('<a href="' + escapeHtml(item.source_url) + '" target="_blank" rel="noreferrer">打开来源帖核验</a>');
      }
      return text + guidanceNote + stepHtml + (links.length ? '<br>' + links.join(" · ") : "");
    }

    function deadlineHtml(item) {
      const hasNoFixedDeadline = item.deadline_source === "no_fixed_deadline";
      const deadline = item.deadline_at ? fmtTime(item.deadline_at) : hasNoFixedDeadline ? "无固定截止" : "截止未知";
      const source = deadlineSourceLabel(item.deadline_source);
      const confidence = item.deadline_confidence !== null && item.deadline_confidence !== undefined
        ? " · 置信度 " + Math.round(Number(item.deadline_confidence) * 100) + "%"
        : "";
      const official = item.official_url
        ? '<br><a href="' + escapeHtml(item.official_url) + '" target="_blank" rel="noreferrer">' + escapeHtml(officialUrlLabel(item.official_url_source)) + '</a>'
        : "";
      const rawText = item.deadline_text ? '<br><span class="muted">' + escapeHtml(localizeText(item.deadline_text, "")) + '</span>' : "";
      return '<span class="tag warn">' + escapeHtml(localizeText(item.duration, "未注明")) + '</span><br>' +
        escapeHtml(deadline) + '<br><span class="tag info">' + escapeHtml(source + confidence) + '</span>' +
        urgencyTag(item) + official + rawText;
    }

    function riskText(item) {
      if (item.status === "unverified") {
        const missing = [];
        if (!item.deadline_at && item.deadline_source !== "no_fixed_deadline") missing.push("截止时间");
        if (!item.source_published_at) missing.push("发布时间");
        if (item.credibility === "unverified") missing.push("来源可信度");
        const reason = missing.length ? "待核验字段：" + missing.join("、") + "。" : "仍需核验条款细节。";
        return reason + localizeText(item.risk_note, "参与前需打开来源帖核验官方条款、额度和截止时间。");
      }
      if (item.section === "onchain") {
        return localizeText(item.risk_note, "链上机会风险较高，需核验合约、锁仓、滑点和收益兑现。");
      }
      if (item.type === "pre_ipo") {
        return localizeText(item.risk_note, "Pre-IPO 存在估值、流动性、锁定期、地区限制和平台对手方风险。");
      }
      if (item.type === "stablecoin_earn") {
        return localizeText(item.risk_note, "需核验 APY、额度、锁仓期限、赎回规则和地区限制。");
      }
      return localizeText(item.risk_note, "需核验活动条款、奖励发放、截止时间和地区限制。");
    }

    function yieldText(item) {
      const maxApy = Number(item.yield_profile?.max_apy);
      const baseApy = Number(item.yield_profile?.base_apy ?? item.apy);
      if (Number.isFinite(maxApy) && Number.isFinite(baseApy) && maxApy > baseApy) {
        return "最高 " + maxApy + "% APY";
      }
      if (Number.isFinite(maxApy)) return maxApy + "% APY";
      if (item.apy !== null && item.apy !== undefined) return item.apy + "% APY";
      return localizeText(item.expected_yield || item.reward, "见来源帖");
    }

    function yieldProfileClass(item) {
      return item.yield_profile?.tone || "info";
    }

    function yieldProfileHtml(item) {
      const profile = item.yield_profile;
      if (!profile) return "";
      const qualifiers = Array.isArray(profile.qualifiers) ? profile.qualifiers : [];
      const qualifierHtml = qualifiers.length
        ? '<br>' + qualifiers.slice(0, 4).map((qualifier) =>
          '<span class="tag ' + yieldProfileClass(item) + '">' + escapeHtml(qualifier) + '</span>'
        ).join("")
        : "";
      return '<br><span class="tag ' + yieldProfileClass(item) + '">' + escapeHtml(profile.label || "收益性质") + '</span>' +
        qualifierHtml;
    }

    function deadlineQualityText(items) {
      const confirmed = items.filter((item) => item.deadline_at).length;
      const noFixed = items.filter((item) => item.deadline_source === "no_fixed_deadline").length;
      const pending = items.length - confirmed - noFixed;
      return confirmed + " 确认 / " + noFixed + " 无固定 / " + pending + " 待确认";
    }

    function officialQualityText(items) {
      const count = items.filter((item) => item.official_url).length;
      return count + " / " + items.length;
    }

    function qualityText(item) {
      const quality = item.data_quality || { score: 0, level: "low", missing: [] };
      const level = { high: "高", medium: "中", low: "低" }[quality.level] || "低";
      return "资料" + level + " " + Number(quality.score || 0) + "%";
    }

    function qualityClass(item) {
      const level = item.data_quality?.level;
      if (level === "high") return "apy";
      if (level === "medium") return "info";
      return "warn";
    }

    function urgencyClass(item) {
      const level = item.urgency?.level;
      if (level === "urgent") return "risk";
      if (level === "soon") return "warn";
      return "info";
    }

    function urgencyTag(item) {
      if (!item.urgency?.label) return "";
      return '<br><span class="tag ' + urgencyClass(item) + '">' + escapeHtml(item.urgency.label) + '</span>';
    }

    function freshnessClass(item) {
      const level = item.freshness?.level;
      if (level === "new" || level === "recent_24") return "apy";
      if (level === "recent_72") return "info";
      if (level === "stale_96") return "warn";
      return "warn";
    }

    function freshnessHtml(item) {
      const freshness = item.freshness || {};
      const basis = freshness.basis_label || "时间";
      const label = freshness.label || "时间未知";
      const age = freshness.age_hours !== null && freshness.age_hours !== undefined
        ? " · " + Number(freshness.age_hours).toFixed(Number(freshness.age_hours) < 10 ? 1 : 0) + "h"
        : "";
      const rawTime = item.source_published_at || item.first_seen_at || item.last_seen_at;
      return '<br><span class="tag ' + freshnessClass(item) + '">' + escapeHtml(basis + "：" + label + age) + '</span>' +
        (rawTime ? '<br><span class="muted">' + escapeHtml(fmtTime(rawTime)) + '</span>' : "");
    }

    function riskClass(item) {
      return item.risk_profile?.tone || "info";
    }

    function riskLevelText(item) {
      return "风险" + (item.risk_profile?.level || "待评估");
    }

    function dataQualityText(items) {
      if (!items.length) return "无数据";
      const avg = Math.round(items.reduce((sum, item) => sum + Number(item.data_quality?.score || 0), 0) / items.length);
      const low = items.filter((item) => item.data_quality?.level === "low").length;
      return "平均 " + avg + "% / 低完整度 " + low;
    }

    function fieldGapQualityText(gaps) {
      if (!gaps) return "无数据";
      const deadline = (gaps.fields || []).find((field) => field.key === "deadline")?.count || 0;
      const official = (gaps.fields || []).find((field) => field.key === "official_url")?.count || 0;
      return gaps.total_items_with_gap + " 项 / 截止 " + deadline + " / 官方 " + official;
    }

    function enrichmentBacklogText(backlog) {
      if (!backlog) return "无数据";
      if (!backlog.enabled) return "补查关闭";
      return "就绪 " + Number(backlog.ready_count || 0) +
        " / 冷却 " + Number(backlog.waiting_cooldown_count || 0) +
        " / 排队 " + Number(backlog.queued_overflow_count || 0);
    }

    function diagnosticStatusText(diagnostics) {
      if (!diagnostics) return "无数据";
      return diagnostics.label + " " + Number(diagnostics.score || 0) + "%";
    }

    function jobStatsSummaryText(run) {
      const stats = Array.isArray(run?.job_stats) ? run.job_stats : [];
      if (!stats.length) return "无明细";
      const ok = stats.filter((job) => job.status === "ok").length;
      const saved = stats.reduce((sum, job) => sum + Number(job.saved_count || 0), 0);
      return ok + "/" + stats.length + " 成功 / 保存 " + saved;
    }

    function diagnosticToneClass(diagnostics) {
      if (!diagnostics) return "info";
      if (diagnostics.status === "critical") return "risk";
      if (diagnostics.status === "needs_attention") return "risk";
      if (diagnostics.status === "watch") return "warn";
      return "apy";
    }

    function freshnessQualityText(items) {
      const within24 = items.filter((item) => item.freshness?.level === "new" || item.freshness?.level === "recent_24").length;
      const within72 = items.filter((item) => ["new", "recent_24", "recent_72"].includes(item.freshness?.level)).length;
      const stale = items.filter((item) => ["stale_96", "stale", "unknown"].includes(item.freshness?.level)).length;
      return within24 + " 24h / " + within72 + " 72h / " + stale + " 旧或未知";
    }

    function watchCountText(items) {
      const count = items.filter((item) => item.review?.label === "观察项").length;
      return count + " / " + items.length;
    }

    function actionableCountText(items) {
      const count = items.filter((item) => item.review?.label === "可参与").length;
      return count + " / " + items.length;
    }

    function urgentCountText(items) {
      const urgent = items.filter((item) => item.urgency?.level === "urgent").length;
      const soon = items.filter((item) => item.urgency?.level === "soon").length;
      return urgent + " 48h / " + (urgent + soon) + " 7天";
    }

    function highRiskCountText(items) {
      const high = items.filter((item) => Number(item.risk_profile?.score || 0) >= 4).length;
      return high + " / " + items.length;
    }

    function coverageQualityText(coverage) {
      const summary = coverage?.summary;
      if (!summary) return "无数据";
      return summary.covered_cells + " / " + summary.total_cells + " 类目";
    }

    function coverageTagClass(cell) {
      if (cell.status === "covered") return "apy";
      if (cell.status === "watch") return "info";
      return "warn";
    }

    function coverageStatusText(cell) {
      if (cell.status === "covered") return cell.count + " 条";
      if (cell.status === "watch") return cell.count + " 条观察";
      return "空白";
    }

    function queryPlanSummaryText(plan) {
      if (!plan) return "无计划";
      const gapJob = (plan.jobs || []).find((job) => job.name === "cex_coverage_gaps");
      const gapSuffix = gapJob ? " / 含缺口补查" : "";
      const adaptiveSuffix = (plan.adaptations || []).length ? " / 自适应降级" : "";
      return (plan.enabled ? "" : "预览关闭 · ") + Number(plan.job_count || 0) + " 个任务" + gapSuffix + adaptiveSuffix;
    }

    function stablecoinTopText(summary) {
      if (!summary?.highest) return "无符合项";
      const item = summary.highest;
      const venue = item.exchange || item.venue || "未知";
      const base = Number(item.base_apy);
      const max = Number(item.apy);
      const baseSuffix = Number.isFinite(base) && Number.isFinite(max) && max > base
        ? "（入库/常规 " + base + "%）"
        : "";
      return venue + " " + item.stablecoin + " " + item.apy + "% APY" + baseSuffix;
    }

    function stablecoinTopConditionHtml(highest) {
      if (!highest) return "";
      const lines = [];
      const max = Number(highest.apy);
      const base = Number(highest.base_apy);
      if (Number.isFinite(base) && Number.isFinite(max) && max > base) {
        lines.push("入库/常规 APY：" + base + "%；促销最高：" + max + "%");
      } else if (Number.isFinite(base)) {
        lines.push("入库/常规 APY：" + base + "%");
      }
      if (highest.yield_summary) lines.push("条件：" + highest.yield_summary);
      if (!lines.length) return "";
      const tags = Array.isArray(highest.condition_tags) ? highest.condition_tags.slice(0, 4) : [];
      const tagHtml = [
        highest.is_promotional_high ? '<span class="tag warn">促销最高</span>' : "",
        ...tags.map((tag) => '<span class="tag warn">' + escapeHtml(tag) + '</span>')
      ].filter(Boolean).join("");
      return '<span class="muted">' + escapeHtml(lines.join(" / ")) + '</span>' +
        (tagHtml ? '<span>' + tagHtml + '</span>' : "");
    }

    function activityText(item) {
      const known = {
        "Bybit IPO Express - SpaceX Tokenized Shares": "Bybit IPO Express - SpaceX 代币化股份",
        "Bitget $SPCX SpaceX IPO Pre-Trading & Predict Contest": "Bitget $SPCX SpaceX Pre-IPO 交易与预测活动",
        "Binance Wallet Football Trading Cup": "Binance 钱包足球交易杯",
        "Bybit Football Season 2026 Predict & Earn": "Bybit 2026 足球赛季预测赚取活动",
        "Binance USD1 Simple Earn Flexible": "Binance USD1 灵活理财",
        "Bybit EU Fixed Earn USDC High APR": "Bybit EU USDC 定期高息理财",
        "Binance Pre-IPO Perps SpaceX/OpenAI Dominance": "Binance Pre-IPO 永续：SpaceX/OpenAI"
      };
      return known[item.activity_name] || localizeText(item.activity_name, "未命名活动");
    }

    function runStatusText(run, monitor, runHealth) {
      if (runHealth?.summary) return runHealth.summary;
      const rawStatus = String(run.status || "").toLowerCase();
      const running = monitor?.running;
      const error = run.error || monitor?.last_error || "";
      const labels = {
        ok: "成功",
        partial: "部分成功",
        error: "失败",
        idle: "待机"
      };
      let text = running ? "采集中" : labels[rawStatus] || rawStatus || "待机";
      if (!error) return text;
      let detail = String(error)
        .replace(/main:/g, "主查询：")
        .replace(/gate_spacex:/g, "Gate/SpaceX 专题：")
        .replace(/cex_coverage_gaps:/g, "CEX 覆盖缺口补查：")
        .replace(/cex_pre_ipo:/g, "CEX Pre-IPO 专题：")
        .replace(/cex_launch:/g, "CEX 打新专题：")
        .replace(/cex_stablecoin_earn:/g, "CEX 稳定币理财专题：")
        .replace(/cex_short_term:/g, "CEX 短期活动专题：")
        .replace(/onchain_stablecoin:/g, "链上稳定币收益专题：")
        .replace(/onchain_points_lp:/g, "链上积分/LP 专题：")
        .replace(/onchain:/g, "链上/DEX 专题：")
        .replace(/hermes_timeout_after_(\\d+)ms/g, (_match, ms) => String(Math.round(Number(ms) / 1000)) + " 秒超时")
        .replace(/xintel_parse_failed/g, "xintel 返回解析失败");
      if (rawStatus === "partial" && detail.includes("主查询：") && detail.includes("秒超时")) {
        detail += "；其他专题结果已保留";
      }
      return text + "：" + detail;
    }

    function defaultItems() {
      return state.items.filter((item) => item.status !== "unverified");
    }

    function filteredItems() {
      const baseItems = state.activeTab === "unverified" ? state.items : defaultItems();
      if (state.activeTab === "all") return baseItems;
      if (state.activeTab === "new") {
        return baseItems.filter((item) => item.freshness?.level === "new" || item.freshness?.level === "recent_24");
      }
      if (state.activeTab === "urgent") {
        return baseItems.filter((item) => item.urgency?.level === "urgent" || item.urgency?.level === "soon");
      }
      if (state.activeTab === "watch") return baseItems.filter((item) => item.review?.label === "观察项");
      if (state.activeTab === "high_risk") return baseItems.filter((item) => Number(item.risk_profile?.score || 0) >= 4);
      if (state.activeTab === "unverified") return state.items.filter((item) => item.status === "unverified");
      if (state.activeTab === "onchain") return baseItems.filter((item) => item.section === "onchain");
      if (state.activeTab === "stablecoin_earn") return baseItems.filter((item) => item.type === "stablecoin_earn");
      return baseItems.filter((item) => item.type === state.activeTab && item.section !== "onchain");
    }

    function renderTabs() {
      const tabs = document.getElementById("tabs");
      const baseItems = defaultItems();
      tabs.innerHTML = tabDefs.map(([id, label]) => {
        const count = id === "all" ? baseItems.length : id === "urgent"
          ? baseItems.filter((item) => item.urgency?.level === "urgent" || item.urgency?.level === "soon").length
          : id === "new"
            ? baseItems.filter((item) => item.freshness?.level === "new" || item.freshness?.level === "recent_24").length
          : id === "watch"
            ? baseItems.filter((item) => item.review?.label === "观察项").length
          : id === "high_risk"
            ? baseItems.filter((item) => Number(item.risk_profile?.score || 0) >= 4).length
          : id === "onchain"
          ? baseItems.filter((item) => item.section === "onchain").length
          : id === "unverified"
            ? state.items.filter((item) => item.status === "unverified").length
          : id === "stablecoin_earn"
            ? baseItems.filter((item) => item.type === "stablecoin_earn").length
          : baseItems.filter((item) => item.type === id && item.section !== "onchain").length;
        return '<button class="tab ' + (state.activeTab === id ? 'active' : '') + '" data-tab="' + id + '">' +
          escapeHtml(label) + ' (' + count + ')</button>';
      }).join("");
      tabs.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", () => {
          state.activeTab = button.dataset.tab;
          render();
        });
      });
    }

    function renderCoverage() {
      const container = document.getElementById("coverage");
      const coverage = state.coverage;
      if (!coverage?.rows?.length) {
        container.innerHTML = "";
        return;
      }
      const summary = coverage.summary || {};
      const gaps = (coverage.gaps || []).slice(0, 8);
      container.innerHTML =
        '<div class="coverage-title"><strong>CEX × 类别覆盖矩阵</strong><span class="muted">' +
        escapeHtml((summary.covered_cells || 0) + "/" + (summary.total_cells || 0) + " 个交易所类目有符合筛选结果；空白代表当前列表未收录或未达门槛") +
        '</span></div>' +
        '<table><thead><tr><th>交易所</th>' +
        coverage.categories.map((category) => '<th>' + escapeHtml(category.label) + '</th>').join("") +
        '</tr></thead><tbody>' +
        coverage.rows.map((row) => '<tr><td>' + escapeHtml(row.exchange) +
          '<br><span class="muted">' + escapeHtml(row.total + " 条 / " + row.covered + " 类") + '</span></td>' +
          row.cells.map((cell) => {
            const detail = [
              cell.actionable ? cell.actionable + " 可参与" : "",
              cell.watch ? cell.watch + " 观察" : "",
              cell.unverified ? cell.unverified + " 待核验" : "",
              cell.urgent ? cell.urgent + " 即将截止" : "",
              cell.highest_apy ? "最高 " + cell.highest_apy + "% APY" : ""
            ].filter(Boolean).join(" / ");
            const examples = cell.examples?.length
              ? '<span class="muted">' + escapeHtml(cell.examples.map((name) => localizeText(name, name)).join(" / ")) + '</span>'
              : '<span class="muted">当前无符合筛选结果</span>';
            return '<td><span class="coverage-cell"><span class="tag ' + coverageTagClass(cell) + '">' +
              escapeHtml(coverageStatusText(cell)) + '</span>' +
              (detail ? '<span class="muted">' + escapeHtml(detail) + '</span>' : '') +
              examples + '</span></td>';
          }).join("") + '</tr>').join("") +
        '</tbody></table>' +
        (gaps.length
          ? '<div class="coverage-title" style="margin-top:12px"><strong>优先补查缺口</strong><span class="muted">' +
            escapeHtml("按空白交易所和高价值类别排序") + '</span></div>' +
            '<div class="gap-list">' + gaps.map((gap) => {
              const tone = gap.priority === "high" ? "risk" : gap.priority === "medium" ? "warn" : "info";
              const priorityText = gap.priority === "high" ? "高优先级" : gap.priority === "medium" ? "中优先级" : "普通";
              return '<div class="gap-item"><strong>' + escapeHtml(gap.exchange + " · " + gap.label) +
                ' <span class="tag ' + tone + '">' + escapeHtml(priorityText) + '</span></strong>' +
                '<span class="muted">' + escapeHtml(gap.reason) + '</span>' +
                '<span class="muted">补查词：' + escapeHtml(gap.suggested_query) + '</span></div>';
            }).join("") + '</div>'
          : "");
    }

    function renderQueryPlan() {
      const container = document.getElementById("queryPlan");
      const plan = state.queryPlan;
      if (!plan?.jobs?.length) {
        container.innerHTML = "";
        return;
      }
      const jobs = plan.jobs.slice(0, 8);
      const disabledNote = plan.enabled ? "" : "当前本地预览关闭自动采集；启用监控后按此计划执行。";
      const adaptations = plan.adaptations || [];
      const adaptationHtml = adaptations.length
        ? '<div class="gap-list">' + adaptations.map((adaptation) =>
          '<div class="gap-item"><strong>' + escapeHtml(adaptation.label || "自适应调整") +
          ' <span class="tag warn">已调整</span></strong>' +
          '<span class="muted">' + escapeHtml(adaptation.reason || "") + '</span></div>'
        ).join("") + '</div>'
        : "";
      container.innerHTML =
        '<div class="coverage-title"><strong>下轮 xintel 查询计划</strong><span class="muted">' +
        escapeHtml((disabledNote || "每轮按任务上限执行，并随覆盖缺口轮换") + " · lookback " + (plan.lookback_hours || 72) + "h") +
        '</span></div>' + adaptationHtml + '<div class="gap-list">' +
        jobs.map((job) => {
          const tone = job.type === "coverage_gap" ? "warn" : job.type === "onchain" ? "risk" : "info";
          const gaps = (job.gaps || []).slice(0, 3);
          const gapText = gaps.length
            ? '<span class="muted">目标缺口：' + escapeHtml(gaps.map((gap) => gap.exchange + "·" + gap.label).join(" / ")) + '</span>'
            : "";
          const queryText = gaps.length
            ? '<span class="muted">补查词：' + escapeHtml(gaps.map((gap) => gap.suggested_query).join(" | ")) + '</span>'
            : "";
          return '<div class="gap-item"><strong>' + escapeHtml(job.label || job.name) +
            ' <span class="tag ' + tone + '">' + escapeHtml(job.type === "coverage_gap" ? "补缺口" : job.type === "onchain" ? "链上" : "CEX") + '</span></strong>' +
            gapText + queryText + '</div>';
        }).join("") + '</div>';
    }

    function renderStablecoinSummary() {
      const container = document.getElementById("stablecoinSummary");
      const summary = state.stablecoinSummary;
      if (!summary || !summary.total) {
        container.innerHTML = "";
        return;
      }
      const highest = summary.highest || {};
      const coins = Object.entries(summary.by_coin || {})
        .map(([coin, count]) => coin + " " + count)
        .join(" / ");
      const sourceLink = highest.source_url
        ? '<a href="' + escapeHtml(highest.source_url) + '" target="_blank" rel="noreferrer">来源帖</a>'
        : "";
      const officialLink = highest.official_url
        ? '<a href="' + escapeHtml(highest.official_url) + '" target="_blank" rel="noreferrer">官方入口</a>'
        : "";
      const links = [sourceLink, officialLink].filter(Boolean).join(" · ");
      container.innerHTML =
        '<div class="coverage-title"><strong>稳定币理财摘要</strong><span class="muted">' +
        escapeHtml("只统计非待核验且 APY>=8% 的 USDT/USDC/USD1 机会") + '</span></div>' +
        '<div class="gap-list"><div class="gap-item"><strong>' +
        escapeHtml("最高收益：" + stablecoinTopText(summary)) + ' <span class="tag apy">最高 APY</span></strong>' +
        '<span class="muted">' + escapeHtml(highest.activity_name || "") + '</span>' +
        stablecoinTopConditionHtml(highest) +
        '<span class="muted">' + escapeHtml("期限：" + (highest.duration || "未注明") + " / 截止：" + (highest.deadline_at ? fmtTime(highest.deadline_at) : "无固定或待确认")) + '</span>' +
        (links ? '<span class="muted">' + links + '</span>' : '') + '</div>' +
        '<div class="gap-item"><strong>' + escapeHtml("覆盖：" + summary.total + " 条") + ' <span class="tag info">稳定币</span></strong>' +
        '<span class="muted">' + escapeHtml("CEX " + summary.cex_total + " / 链上 " + summary.onchain_total) + '</span>' +
        '<span class="muted">' + escapeHtml("币种：" + (coins || "无")) + '</span></div></div>';
    }

    function runHealthClass(health) {
      if (health?.running) return "info";
      if (health?.ok) return "apy";
      if (health?.partial) return "warn";
      if (health?.status === "error") return "risk";
      return "info";
    }

    function runIssueSummary(health) {
      const issues = health?.issues || [];
      if (!issues.length) return "无";
      const text = issues.slice(0, 2).map((issue) => issue.job_label + "：" + issue.label).join("；");
      return issues.length > 2 ? text + "；另 " + (issues.length - 2) + " 个" : text;
    }

    function runSummaryText(health) {
      const summary = String(health?.summary || "").trim();
      const label = String(health?.label || "").trim();
      if (!summary || summary === label) return "";
      const prefix = label + "：";
      return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
    }

    function renderRunHistory() {
      const container = document.getElementById("runHistory");
      const runs = state.recentRuns || [];
      const title =
        '<div class="coverage-title"><strong>近期采集</strong><span class="muted">最近 5 轮 xintel 调用，定位连续超时、部分成功和字段缺失</span></div>';
      if (!runs.length) {
        container.innerHTML = title + '<div class="empty">暂无采集历史。</div>';
        return;
      }
      container.innerHTML = title +
        '<table><thead><tr><th>时间</th><th>状态</th><th>保存条数</th><th>耗时</th><th>问题摘要</th></tr></thead><tbody>' +
        runs.map((run) => {
          const health = run.run_health || {};
          const duration = health.duration_ms === null || health.duration_ms === undefined
            ? (health.running ? "进行中" : "未知")
            : formatDuration(health.duration_ms);
          return '<tr><td>' + escapeHtml(fmtTime(run.finished_at || run.started_at)) +
            '<br><span class="muted">' + escapeHtml(run.started_at ? "开始：" + fmtTime(run.started_at) : "") + '</span></td>' +
            '<td><span class="tag ' + runHealthClass(health) + '">' + escapeHtml(health.label || run.status || "未知") + '</span><br>' +
              '<span class="muted">' + escapeHtml(runSummaryText(health)) + '</span></td>' +
            '<td>' + escapeHtml(String(health.item_count ?? run.item_count ?? 0)) + '</td>' +
            '<td>' + escapeHtml(duration) + '</td>' +
            '<td>' + escapeHtml(runIssueSummary(health)) + '</td></tr>';
        }).join("") + '</tbody></table>';
    }

    function jobStatusLabel(status) {
      return {
        ok: "成功",
        error: "失败",
        parse_failed: "解析失败"
      }[String(status || "").toLowerCase()] || "未知";
    }

    function jobStatusClass(status) {
      if (status === "ok") return "apy";
      if (status === "parse_failed") return "warn";
      return "risk";
    }

    function jobDropReasonText(job) {
      const reasons = job.drop_reasons || [];
      if (!reasons.length) return "无";
      return reasons.slice(0, 3).map((reason) => reason.label + " " + reason.count).join(" / ");
    }

    function renderJobStats() {
      const container = document.getElementById("jobStats");
      const stats = Array.isArray(state.latestRun?.job_stats) ? state.latestRun.job_stats : [];
      const title =
        '<div class="coverage-title"><strong>本轮任务明细</strong><span class="muted">每个 xintel 子查询的耗时、候选数、规范化条数和保存条数</span></div>';
      if (!stats.length) {
        container.innerHTML = title + '<div class="empty">最近 run 没有任务级明细；新版本采集后会自动记录。</div>';
        return;
      }
      container.innerHTML = title +
        '<table><thead><tr><th>任务</th><th>状态</th><th>候选</th><th>通过筛选</th><th>保存</th><th>过滤</th><th>耗时</th><th>错误/补查目标</th></tr></thead><tbody>' +
        stats.map((job) => {
          const gaps = (job.gaps || []).slice(0, 2).map((gap) => gap.exchange + "·" + gap.label).join(" / ");
          const detail = job.error || (gaps ? "目标：" + gaps : "");
          return '<tr><td><strong>' + escapeHtml(job.label || job.name || "未知任务") + '</strong><br><span class="muted">' +
            escapeHtml(job.type || "") + '</span></td>' +
            '<td><span class="tag ' + jobStatusClass(job.status) + '">' + escapeHtml(jobStatusLabel(job.status)) + '</span>' +
            (job.fallback ? '<br><span class="tag info">旧记录推导</span>' : '') + '</td>' +
            '<td>' + escapeHtml(String(job.candidate_count ?? 0)) + '</td>' +
            '<td>' + escapeHtml(String(job.normalized_count ?? 0)) + '</td>' +
            '<td>' + escapeHtml(String(job.saved_count ?? 0)) + '</td>' +
            '<td>' + escapeHtml(String(job.drop_count ?? 0)) + '<br><span class="muted">' + escapeHtml(jobDropReasonText(job)) + '</span></td>' +
            '<td>' + escapeHtml(formatDuration(job.duration_ms || 0)) + '<br><span class="muted">' + escapeHtml(String(job.raw_length || 0) + " chars") + '</span></td>' +
            '<td>' + escapeHtml(detail || "无") + '</td></tr>';
        }).join("") + '</tbody></table>';
    }

    function fieldGapTone(field) {
      if (field.key === "deadline" && field.count) return "risk";
      if (field.count) return "warn";
      return "info";
    }

    function renderFieldGaps() {
      const container = document.getElementById("fieldGaps");
      const gaps = state.fieldGaps;
      if (!gaps) {
        container.innerHTML = "";
        return;
      }
      const fields = (gaps.fields || []).filter((field) => field.count > 0);
      const title =
        '<div class="coverage-title"><strong>待补字段</strong><span class="muted">' +
        escapeHtml("按截止时间、官方入口、参与方式等关键缺口聚合；用于决定下一轮补查重点") +
        '</span></div>';
      if (!fields.length) {
        container.innerHTML = title + '<div class="empty">当前列表没有关键字段缺口。</div>';
        return;
      }
      container.innerHTML = title + '<div class="gap-list">' + fields.map((field) => {
        const examples = (field.examples || []).map((item) => {
          const venue = item.exchange || item.venue || "未知项目";
          const apy = item.apy !== null && item.apy !== undefined ? " · " + item.apy + "% APY" : "";
          const source = item.source_url
            ? ' · <a href="' + escapeHtml(item.source_url) + '" target="_blank" rel="noreferrer">来源</a>'
            : "";
          return '<span class="muted">' + escapeHtml(venue + " · " + activityText(item) + apy) + source + '</span>';
        }).join("");
        return '<div class="gap-item"><strong>' + escapeHtml(field.label + "：" + field.count + " 条") +
          ' <span class="tag ' + fieldGapTone(field) + '">' + escapeHtml(field.key === "deadline" ? "优先补截止" : "需补查") + '</span></strong>' +
          '<span class="muted">' + escapeHtml(field.description) + '</span>' +
          (examples || '<span class="muted">暂无样例</span>') + '</div>';
      }).join("") + '</div>';
    }

    function enrichmentBacklogItemHtml(item, tone, label) {
      const venue = item.exchange || item.venue || "未知项目";
      const asset = item.stablecoin || item.asset || "";
      const apy = item.apy !== null && item.apy !== undefined ? " · " + item.apy + "% APY" : "";
      const reasons = item.reasons?.length ? item.reasons.join("、") : "待补查";
      const source = item.source_url
        ? '<a href="' + escapeHtml(item.source_url) + '" target="_blank" rel="noreferrer">来源帖</a>'
        : "无来源帖";
      const official = item.official_url
        ? '<a href="' + escapeHtml(item.official_url) + '" target="_blank" rel="noreferrer">' + escapeHtml(officialUrlLabel(item.official_url_source)) + '</a>'
        : "无官方入口";
      const deadline = item.deadline_at
        ? fmtTime(item.deadline_at)
        : item.deadline_source === "no_fixed_deadline"
          ? "无固定截止"
          : "截止未知";
      const retry = item.retry_after_at
        ? '<span class="muted">下次可补查：' + escapeHtml(fmtTime(item.retry_after_at)) + '</span>'
        : "";
      const last = item.enriched_at
        ? '<span class="muted">上次补查：' + escapeHtml(fmtTime(item.enriched_at)) + '</span>'
        : "";
      const error = item.enrichment_error
        ? '<span class="muted">错误：' + escapeHtml(item.enrichment_error) + '</span>'
        : "";
      return '<div class="gap-item"><strong>' + escapeHtml(venue + " · " + activityText(item)) +
        ' <span class="tag ' + tone + '">' + escapeHtml(label) + '</span></strong>' +
        '<span class="muted">' + escapeHtml(typeLabel(item.type) + (asset ? " · " + asset : "") + apy) + '</span>' +
        '<span class="muted">原因：' + escapeHtml(reasons) + '</span>' +
        '<span class="muted">截止：' + escapeHtml(deadline + " / " + deadlineSourceLabel(item.deadline_source)) + '</span>' +
        '<span class="muted">' + source + ' · ' + official + '</span>' +
        last + retry + error + '</div>';
    }

    function renderEnrichmentBacklog() {
      const container = document.getElementById("enrichmentBacklog");
      const backlog = state.enrichmentBacklog;
      if (!backlog) {
        container.innerHTML = "";
        return;
      }
      const title =
        '<div class="coverage-title"><strong>官方/截止补查队列</strong><span class="muted">' +
        escapeHtml("ready 会在下一轮优先用官方网页爬取，必要时再用 Grok 单条补查；冷却避免反复打同一来源") +
        '</span></div>';
      if (!backlog.enabled) {
        container.innerHTML = title + '<div class="empty">官方链接/截止时间补查当前关闭。</div>';
        return;
      }
      const ready = backlog.ready || [];
      const waiting = backlog.waiting_cooldown || [];
      const overflow = backlog.queued_overflow || [];
      if (!ready.length && !waiting.length && !overflow.length) {
        container.innerHTML = title + '<div class="empty">当前没有等待补查的官方入口/截止时间缺口。</div>';
        return;
      }
      const readyHtml = ready.map((item) => enrichmentBacklogItemHtml(item, "risk", "下轮补查")).join("");
      const waitingHtml = waiting.map((item) => enrichmentBacklogItemHtml(item, "warn", "冷却中")).join("");
      const overflowHtml = overflow.map((item) => enrichmentBacklogItemHtml(item, "info", "排队中")).join("");
      container.innerHTML = title +
        '<div class="gap-list">' +
        '<div class="gap-item"><strong>队列概览 <span class="tag info">' + escapeHtml(enrichmentBacklogText(backlog)) + '</span></strong>' +
        '<span class="muted">' + escapeHtml("每轮旧机会补查上限 " + Number(backlog.retry_limit || 0) + " 条；失败后冷却 " + Number(backlog.cooldown_hours || 0) + " 小时。") + '</span>' +
        '<span class="muted">' + escapeHtml("总候选 " + Number(backlog.total_candidates || 0) + " 条；ready 列表最多展示前 5 条。") + '</span></div>' +
        readyHtml + waitingHtml + overflowHtml + '</div>';
    }

    function diagnosticSuggestionHtml(action) {
      const suggestion = String(action.suggested_query || "").trim();
      if (!suggestion) return "";
      if (/^https?:\\/\\//i.test(suggestion)) {
        return '<span class="muted"><a href="' + escapeHtml(suggestion) + '" target="_blank" rel="noreferrer">打开依据链接</a></span>';
      }
      return '<span class="muted">补查词：' + escapeHtml(suggestion) + '</span>';
    }

    function filterSummaryHtml(summary) {
      if (!summary || !summary.candidate_count) return "";
      const passRatio = summary.pass_ratio === null || summary.pass_ratio === undefined
        ? "未知"
        : Math.round(Number(summary.pass_ratio) * 100) + "%";
      const reasons = summary.top_reasons?.length
        ? summary.top_reasons.slice(0, 3).map((reason) =>
          '<span class="muted">' + escapeHtml(reason.label + "：" + reason.count + " 个" +
            (reason.examples?.length ? "；样例：" + reason.examples.slice(0, 2).join(" / ") : "")) + '</span>'
        ).join("")
        : '<span class="muted">无过滤原因。</span>';
      const tone = summary.drop_count ? "warn" : "apy";
      return '<div class="gap-item"><strong>过滤摘要 <span class="tag ' + tone + '">' +
        escapeHtml(String(summary.drop_count || 0) + " 个过滤") + '</span></strong>' +
        '<span class="muted">' + escapeHtml("候选 " + summary.candidate_count + " / 通过 " + summary.normalized_count + " / 保存 " + summary.saved_count + " / 通过率 " + passRatio) + '</span>' +
        reasons + '</div>';
    }

    function renderDiagnostics() {
      const container = document.getElementById("diagnostics");
      const diagnostics = state.diagnostics;
      if (!diagnostics) {
        container.innerHTML = "";
        return;
      }
      const issues = diagnostics.issues || [];
      const actions = diagnostics.action_items || [];
      const strengths = diagnostics.strengths || [];
      const filterHtml = filterSummaryHtml(diagnostics.filter_summary);
      const issueHtml = issues.length
        ? '<div class="gap-item"><strong>主要问题 <span class="tag ' + diagnosticToneClass(diagnostics) + '">' +
          escapeHtml(diagnostics.label) + '</span></strong>' +
          issues.slice(0, 4).map((issue) => '<span class="muted">' + escapeHtml(issue.title + "：" + issue.detail + "；建议：" + issue.action) + '</span>').join("") +
          '</div>'
        : '<div class="gap-item"><strong>主要问题 <span class="tag apy">无关键问题</span></strong><span class="muted">当前没有需要优先处理的采集或字段缺口。</span></div>';
      const actionHtml = actions.length
        ? '<div class="gap-item"><strong>下一步动作 <span class="tag warn">' + escapeHtml(actions.length + " 项") + '</span></strong>' +
          actions.slice(0, 5).map((action) => '<span class="muted"><b>' + escapeHtml(action.title) + '</b>：' + escapeHtml(action.detail) + '</span>' + diagnosticSuggestionHtml(action)).join("") +
          '</div>'
        : '<div class="gap-item"><strong>下一步动作 <span class="tag info">暂无</span></strong><span class="muted">当前诊断没有生成额外补查动作。</span></div>';
      const strengthHtml = strengths.length
        ? '<div class="gap-item"><strong>已达标项 <span class="tag apy">' + escapeHtml(strengths.length + " 项") + '</span></strong>' +
          strengths.map((item) => '<span class="muted">' + escapeHtml(item.title + "：" + item.detail) + '</span>').join("") +
          '</div>'
        : "";
      container.innerHTML =
        '<div class="coverage-title"><strong>采集诊断</strong><span class="muted">' +
        escapeHtml(diagnostics.summary || "") + '</span></div>' +
        '<div class="gap-list">' + issueHtml + filterHtml + actionHtml + strengthHtml + '</div>';
    }

    function renderTable() {
      const content = document.getElementById("content");
      const items = filteredItems();
      if (items.length === 0) {
        content.className = "empty";
        content.textContent = state.activeTab === "onchain"
          ? "当前没有链上/DEX active 或待核验机会。可能是本轮 xintel 没收录，也可能是来源、截止时间或收益门槛未通过。"
          : "当前没有符合筛选条件的 active 或待核验机会。";
        return;
      }
      content.className = "table-wrap";
      content.innerHTML = '<table><thead><tr>' +
        '<th>活动</th><th>状态</th><th>交易所/项目</th><th>币种</th><th>收益</th><th>期限/截止</th>' +
        '<th>参与方式</th><th>来源</th><th>风险</th>' +
        '</tr></thead><tbody>' + items.map((item) => {
          const source = item.source_url
            ? '<a href="' + escapeHtml(item.source_url) + '" target="_blank" rel="noreferrer">' + escapeHtml(item.source_user || "X来源") + '</a>'
            : escapeHtml(item.source_user || "未提供");
          const venue = item.section === "cex" ? item.exchange : item.venue;
          const missing = item.data_quality?.missing?.length
            ? '<br><span class="muted">缺：' + escapeHtml(item.data_quality.missing.join("、")) + '</span>'
            : "";
          const reviewReason = item.review?.reason ? '<br><span class="muted">' + escapeHtml(item.review.reason) + '</span>' : "";
          const riskReasons = item.risk_profile?.reasons?.length
            ? '<br><span class="muted">' + escapeHtml(item.risk_profile.reasons.join("、")) + '</span>'
            : "";
          return '<tr>' +
            '<td class="name">' + escapeHtml(activityText(item)) + '<br><span class="tag info">' + escapeHtml(typeLabel(item.type)) + '</span></td>' +
            '<td><span class="tag ' + reviewClass(item) + '">' + escapeHtml(reviewLabel(item)) + '</span><br>' +
              '<span class="tag ' + qualityClass(item) + '">' + escapeHtml(qualityText(item)) + '</span>' + missing + reviewReason + '</td>' +
            '<td>' + escapeHtml(venue || "") + '<br><span class="muted">' + escapeHtml(item.section === "cex" ? "CEX" : "链上/DEX") + '</span></td>' +
            '<td>' + escapeHtml(item.stablecoin || item.asset || "") + '</td>' +
            '<td><span class="tag apy">' + escapeHtml(yieldText(item)) + '</span>' + yieldProfileHtml(item) +
              '<br>' + escapeHtml(localizeText(item.reward || item.expected_yield, "")) + '</td>' +
            '<td>' + deadlineHtml(item) + '</td>' +
            '<td>' + participationHtml(item) + '</td>' +
            '<td>' + source + '<br><span class="tag">' + escapeHtml(credibilityLabel(item.credibility)) + '</span>' + freshnessHtml(item) + '</td>' +
            '<td><span class="tag ' + riskClass(item) + '">' + escapeHtml(riskLevelText(item)) + '</span><br>' +
              '<span class="tag risk">' + escapeHtml(riskText(item)) + '</span>' + riskReasons + '</td>' +
            '</tr>';
        }).join("") + '</tbody></table>';
    }

    function renderStatus() {
      const run = state.latestRun || {};
      document.getElementById("lastRun").textContent = fmtTime(run.finished_at || run.started_at);
      document.getElementById("nextRun").textContent = nextRunText(state.monitor, state.queryPlan);
      document.getElementById("runStatus").textContent = runStatusText(run, state.monitor, state.runHealth);
      document.getElementById("totalCount").textContent = String(state.items.length);
      document.getElementById("coverageQuality").textContent = coverageQualityText(state.coverage);
      document.getElementById("queryPlanSummary").textContent = queryPlanSummaryText(state.queryPlan);
      document.getElementById("stablecoinTop").textContent = stablecoinTopText(state.stablecoinSummary);
      document.getElementById("freshnessQuality").textContent = freshnessQualityText(state.items);
      document.getElementById("actionableCount").textContent = actionableCountText(state.items);
      document.getElementById("deadlineQuality").textContent = deadlineQualityText(state.items);
      document.getElementById("officialQuality").textContent = officialQualityText(state.items);
      document.getElementById("dataQuality").textContent = dataQualityText(state.items);
      document.getElementById("fieldGapQuality").textContent = fieldGapQualityText(state.fieldGaps);
      document.getElementById("enrichmentBacklogMetric").textContent = enrichmentBacklogText(state.enrichmentBacklog);
      document.getElementById("diagnosticStatus").textContent = diagnosticStatusText(state.diagnostics);
      document.getElementById("jobStatsSummary").textContent = jobStatsSummaryText(run);
      document.getElementById("watchCount").textContent = watchCountText(state.items);
      document.getElementById("urgentCount").textContent = urgentCountText(state.items);
      document.getElementById("highRiskCount").textContent = highRiskCountText(state.items);
    }

    function render() {
      renderStatus();
      renderCoverage();
      renderQueryPlan();
      renderStablecoinSummary();
      renderRunHistory();
      renderJobStats();
      renderDiagnostics();
      renderFieldGaps();
      renderEnrichmentBacklog();
      renderTabs();
      renderTable();
    }

    async function load() {
      const response = await fetch("/api/opportunities");
      const body = await response.json();
      state.items = body.items || [];
      state.coverage = body.coverage || null;
      state.queryPlan = body.query_plan || null;
      state.stablecoinSummary = body.stablecoin_summary || null;
      state.recentRuns = body.recent_runs || [];
      state.fieldGaps = body.field_gaps || null;
      state.enrichmentBacklog = body.enrichment_backlog || null;
      state.diagnostics = body.collection_diagnostics || null;
      state.latestRun = body.latest_run || null;
      state.runHealth = body.run_health || null;
      state.monitor = body.monitor || null;
      render();
    }

    load().catch((error) => {
      document.getElementById("content").className = "empty";
      document.getElementById("content").textContent = "加载失败: " + error.message;
    });
    setInterval(load, 30000);
    setInterval(() => {
      document.getElementById("nextRun").textContent = nextRunText(state.monitor, state.queryPlan);
    }, 1000);
  </script>
</body>
</html>`;
}

export function createHttpServer({
  config,
  db,
  getRuntimeStatus,
  getOpportunityStatus,
  getOpportunityQueryPlan,
  tradingViewSignalStore
}) {
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

  app.get("/api/opportunities", (_req, res) => {
    try {
      const items = getDisplayOpportunityItems(db, config);
      const monitor = getOpportunityStatus?.() || { enabled: false, running: false };
      const recentRuns = getOpportunityRunsWithHealth(db, monitor, 5);
      const latestRun = decorateOpportunityRun(db.getLatestOpportunityRun?.(), monitor) || stripRunHealth(recentRuns[0]) || null;
      const queryPlan = getOpportunityQueryPlan?.() || null;
      const runHealth = buildOpportunityRunHealth(latestRun || {}, monitor);
      const grouped = groupOpportunities(items);
      const coverage = buildCexCoverage(items);
      const stablecoinSummary = buildStablecoinSummary(items);
      const fieldGaps = buildOpportunityFieldGaps(items);
      const enrichmentBacklog = buildOpportunityEnrichmentBacklog(db, config, items);
      const diagnostics = buildOpportunityDiagnostics({
        items,
        coverage,
        fieldGaps,
        stablecoinSummary,
        runHealth,
        recentRuns,
        queryPlan,
        latestRun
      });
      const deadlineSources = items.reduce((acc, item) => {
        const key = item.deadline_source || "pending";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const deadlineQuality = {
        confirmed: items.filter((item) => item.deadline_at).length,
        no_fixed_deadline: items.filter((item) => item.deadline_source === "no_fixed_deadline").length,
        pending: items.filter((item) => !item.deadline_at && item.deadline_source !== "no_fixed_deadline").length
      };
      const officialQuality = {
        linked: items.filter((item) => item.official_url).length,
        missing: items.filter((item) => !item.official_url).length
      };
      const dataQuality = {
        average_score: items.length
          ? Math.round(items.reduce((sum, item) => sum + item.data_quality.score, 0) / items.length)
          : 0,
        high: items.filter((item) => item.data_quality.level === "high").length,
        medium: items.filter((item) => item.data_quality.level === "medium").length,
        low: items.filter((item) => item.data_quality.level === "low").length
      };
      const watchTotal = items.filter((item) => item.review.label === "观察项").length;
      const actionableTotal = items.filter((item) => item.review.label === "可参与").length;
      const urgencySummary = {
        urgent_48h: items.filter((item) => item.urgency.level === "urgent").length,
        soon_7d: items.filter((item) => item.urgency.level === "soon").length,
        within_7d: items.filter((item) => item.urgency.level === "urgent" || item.urgency.level === "soon").length,
        no_fixed_deadline: items.filter((item) => item.urgency.level === "watch").length,
        pending: items.filter((item) => item.urgency.level === "pending").length
      };
      const freshnessSummary = {
        new_6h: items.filter((item) => item.freshness.level === "new").length,
        within_24h: items.filter((item) => item.freshness.level === "new" || item.freshness.level === "recent_24").length,
        within_72h: items.filter((item) => ["new", "recent_24", "recent_72"].includes(item.freshness.level)).length,
        stale_or_unknown: items.filter((item) => ["stale_96", "stale", "unknown"].includes(item.freshness.level)).length
      };
      const riskSummary = {
        extreme: items.filter((item) => item.risk_profile.score >= 5).length,
        high: items.filter((item) => item.risk_profile.score === 4).length,
        medium: items.filter((item) => item.risk_profile.score === 3).length,
        low: items.filter((item) => item.risk_profile.score <= 2).length
      };
      res.json({
        ok: true,
        generated_at: new Date().toISOString(),
        monitor,
        query_plan: queryPlan,
        latest_run: latestRun,
        run_health: runHealth,
        recent_runs: recentRuns,
        total: items.length,
        active_total: items.filter((item) => item.status === "active").length,
        actionable_total: actionableTotal,
        unverified_total: items.filter((item) => item.status === "unverified").length,
        watch_total: watchTotal,
        deadline_sources: deadlineSources,
        deadline_quality: deadlineQuality,
        official_quality: officialQuality,
        data_quality: dataQuality,
        urgency: urgencySummary,
        freshness: freshnessSummary,
        risk: riskSummary,
        coverage,
        stablecoin_summary: stablecoinSummary,
        field_gaps: fieldGaps,
        enrichment_backlog: enrichmentBacklog,
        collection_diagnostics: diagnostics,
        items,
        sections: grouped.bySection,
        categories: grouped.byType
      });
    } catch (error) {
      logger.warn("opportunities_api_failed", { error: String(error.message || error) });
      res.status(500).json({ ok: false, error: "opportunities_api_failed" });
    }
  });

  app.get("/api/opportunities/export.csv", (_req, res) => {
    try {
      const items = getDisplayOpportunityItems(db, config);
      const csv = buildOpportunitiesCsv(items);
      res
        .type("text/csv; charset=utf-8")
        .set("content-disposition", "attachment; filename=opportunities.csv")
        .send(`\ufeff${csv}`);
    } catch (error) {
      logger.warn("opportunities_csv_failed", { error: String(error.message || error) });
      res.status(500).type("text/plain").send("opportunities_csv_failed");
    }
  });

  app.get("/api/opportunities/runs/latest", (_req, res) => {
    const monitor = getOpportunityStatus?.() || { enabled: false, running: false };
    const latestRun = decorateOpportunityRun(db.getLatestOpportunityRun?.(), monitor) || null;
    res.json({
      ok: true,
      monitor,
      query_plan: getOpportunityQueryPlan?.() || null,
      latest_run: latestRun,
      run_health: buildOpportunityRunHealth(latestRun || {}, monitor)
    });
  });

  app.get("/api/opportunities/runs", (_req, res) => {
    const monitor = getOpportunityStatus?.() || { enabled: false, running: false };
    const runs = getOpportunityRunsWithHealth(db, monitor, 10);
    const latestRun = decorateOpportunityRun(db.getLatestOpportunityRun?.(), monitor) || stripRunHealth(runs[0]) || null;
    res.json({
      ok: true,
      monitor,
      query_plan: getOpportunityQueryPlan?.() || null,
      latest_run: latestRun,
      run_health: buildOpportunityRunHealth(latestRun || {}, monitor),
      runs
    });
  });

  app.get("/opportunities", (_req, res) => {
    res.type("html").send(buildOpportunitiesPage());
  });

  app.post("/webhook/tradingview", (req, res) => {
    if (!config.enableTradingViewWebhook) {
      res.status(404).json({ ok: false, error: "webhook_disabled" });
      return;
    }

    const expectedSecret = String(config.tradingViewWebhookSecret || "").trim();
    if (!expectedSecret) {
      db?.recordHealth?.("tradingview_webhook", "error", "secret_missing");
      logger.warn("tradingview_webhook_secret_missing");
      res.status(503).json({ ok: false, error: "webhook_secret_missing" });
      return;
    }

    const secret = String(req.get("x-tradingview-secret") || req.body?.secret || "").trim();
    if (secret !== expectedSecret) {
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
