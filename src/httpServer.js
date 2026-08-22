import express from "express";
import { logger } from "./logger.js";
import { buildCexCoverage } from "./opportunityAnalytics.js";
import { parseMaxApyPercent } from "./opportunityUtils.js";

const OPPORTUNITY_TYPE_LABELS = {
  stablecoin_earn: "稳定币理财",
  launch: "打新",
  pre_tge: "Pre-TGE",
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

const DISPLAY_CATEGORY_LABELS = {
  stablecoin_yield: "稳定币高息",
  quick_opportunity: "短期机会",
  watch_opportunity: "观察项"
};

function groupOpportunities(rows) {
  const bySection = { cex: [], onchain: [] };
  const byType = {
    stablecoin_earn: [],
    launch: [],
    pre_tge: [],
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
    ["展示分类", (item) => DISPLAY_CATEGORY_LABELS[item.display_category] || OPPORTUNITY_TYPE_LABELS[item.type] || item.type],
    ["展示理由", (item) => item.display_reason],
    ["类型", (item) => OPPORTUNITY_TYPE_LABELS[item.type] || item.type],
    ["状态", (item) => item.review?.label || item.status],
    ["交易所/项目", (item) => item.exchange || item.venue],
    ["分区", (item) => (item.section === "onchain" ? "链上/DEX" : "CEX")],
    ["币种", (item) => item.asset],
    ["稳定币", (item) => item.stablecoin],
    ["APY", (item) => item.apy],
    ["最高APY", (item) => item.yield_profile?.max_apy ?? item.apy],
    ["入库/常规APY", (item) => item.yield_profile?.base_apy ?? item.apy],
    ["事件类型", (item) => item.campaign_profile?.event_type],
    ["平台路径", (item) => item.campaign_profile?.platform_path],
    ["额度", (item) => item.campaign_profile?.quota_label],
    ["派息", (item) => item.campaign_profile?.payout_label],
    ["锁仓/赎回", (item) => item.campaign_profile?.lock_label],
    ["到期/剩余", (item) => item.campaign_profile?.time_left_label],
    ["估算收益", (item) => item.campaign_profile?.estimated_return_label],
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

const DISPLAY_STABLECOINS = new Set(["USDT", "USDC", "USD1"]);

const EXCLUDED_OPPORTUNITY_PATTERNS = [
  /invite/i,
  /referral/i,
  /leaderboard/i,
  /\brank(?:ing)?\b/i,
  /volume competition/i,
  /trading competition/i,
  /trade-to-earn/i,
  /candybomb/i,
  /share .*pool .*volume/i,
  /trading volume/i,
  /交易量排名/,
  /交易量/,
  /交易比赛/,
  /交易竞赛/,
  /排行榜/,
  /排名/,
  /邀请好友/,
  /邀请/,
  /拉新/,
  /抽奖/,
  /神秘盒子/,
  /瓜分.*奖池/,
  /奖池.*瓜分/
];

function displayTextForOpportunity(item) {
  return [
    item.activity_name,
    item.type,
    item.exchange,
    item.venue,
    item.asset,
    item.stablecoin,
    item.expected_yield,
    item.reward,
    item.duration,
    item.deadline_text,
    item.participation,
    item.risk_note,
    item.source_user
  ]
    .filter(Boolean)
    .join(" \n ");
}

function normalizedOpportunityText(item) {
  return displayTextForOpportunity(item).toLowerCase();
}

function parseCampaignDays(text) {
  const value = String(text || "");
  const matches = [
    ...value.matchAll(/(\d+(?:\.\d+)?)\s*[-\s]?(?:day|days|天|日)/gi),
    ...value.matchAll(/(?:lock(?:ed|up)?|fixed|term|duration|period|redeem|redemption|锁仓|定期|固定|期限|赎回)[^\d]{0,18}(\d+(?:\.\d+)?)/gi)
  ]
    .map((match) => Number(match[1]))
    .filter((days) => Number.isFinite(days) && days > 0 && days <= 730);
  return matches.length ? Math.max(...matches) : null;
}

function inferCampaignEventType(row = {}) {
  const text = normalizedOpportunityText(row);
  if (row.type === "pre_tge" || /pre[-\s]?tge|token generation|代币生成/.test(text)) return "Pre-TGE";
  if (row.type === "pre_ipo" || /pre[-\s]?ipo|pre[-\s]?market|预上市|上市前/.test(text)) return "Pre-IPO";
  if (row.type === "stablecoin_earn") {
    if (/flexible|simple earn|soft staking|活期|灵活|no lock|无锁|redeem anytime|随时赎回/.test(text)) return "活期";
    if (/fixed earn|fixed|locked|lockup|lock-up|定期|固定期限|锁仓/.test(text)) return "锁定";
    return "活期";
  }
  if (row.type === "launch" || /launchpad|launchpool|startup|ieo|ido|ico|打新/.test(text)) return "打新";
  if (row.section === "onchain" || /onchain|dex|dapp|defi|链上/.test(text)) return "链上";
  if (/flexible|simple earn|soft staking|活期|灵活|no lock|无锁|redeem anytime|随时赎回/.test(text)) return "活期";
  if (/fixed earn|fixed|locked|lockup|lock-up|定期|固定期限|锁仓/.test(text)) return "锁定";
  return OPPORTUNITY_TYPE_LABELS[row.type] || "活动";
}

function buildCampaignPlatformPath(row = {}, eventType = "活动") {
  const text = normalizedOpportunityText(row);
  const venue = row.exchange || row.venue || "未知平台";
  if (row.section === "onchain") return `${venue} → 链上`;
  const entry = /wallet|web3|dapp|钱包/i.test(`${row.venue || ""} ${row.participation || ""} ${text}`) ? "钱包" : "主站";
  return `${venue} ${entry} → ${eventType}`;
}

function formatCampaignAmount(rawAmount, rawCurrency = "") {
  const amount = Number(String(rawAmount || "").replace(/,/g, ""));
  if (!Number.isFinite(amount)) return "";
  const formatted = amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const currency = String(rawCurrency || "").toUpperCase();
  if (!currency || currency === "USD" || currency === "美元") return `$${formatted}`;
  return `${formatted} ${currency}`;
}

function parseCampaignQuota(row = {}) {
  const text = displayTextForOpportunity(row);
  if (/unlimited|no cap|no limit|无限额|不限额度|无上限/i.test(text)) {
    return { quota_label: "无限额", quota_type: "unlimited" };
  }
  const amountPatterns = [
    /(?:quota|cap|limit|allocation|max(?:imum)?|capacity|额度|限额|配额|上限|最多|单人|每人|\/人)[^\d$＄]{0,24}(?:\$|＄)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(USDT|USDC|USD1|USD|U|美元)?/i,
    /(?:\$|＄)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(USDT|USDC|USD1|USD|U|美元)\s*(?:quota|cap|limit|allocation|额度|限额|配额|上限|per user|\/人|每人|单人)/i
  ];
  for (const pattern of amountPatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const amount = formatCampaignAmount(match[1], match[2]);
    if (amount) return { quota_label: `额度 ${amount}`, quota_type: "capped" };
  }
  if (/quota|cap|limit|allocation|limited pool|first-come|额度|限额|配额|限池|先到先得/i.test(text)) {
    return { quota_label: "额度有限", quota_type: "capped" };
  }
  return { quota_label: "额度待核验", quota_type: "unknown" };
}

function parseCampaignPayout(row = {}) {
  const text = displayTextForOpportunity(row);
  if (/hourly payout|hourly rewards?|每小时派息|每小时发放|按小时派息|小时派息/i.test(text)) return "每小时派息";
  if (/daily payout|daily rewards?|daily interest|每天派息|每日派息|每日发放|按日发放|按日派息/i.test(text)) return "每天派息";
  if (/weekly payout|weekly rewards?|每周派息|每周发放|按周派息/i.test(text)) return "每周派息";
  if (/monthly payout|monthly rewards?|每月派息|每月发放|按月派息/i.test(text)) return "每月派息";
  if (/real[-\s]?time apr|real[-\s]?time rewards?|实时\s*(?:apr|apy|奖励|计息|派息)/i.test(text)) return "实时计息";
  return "派息待核验";
}

function parseCampaignLock(row = {}) {
  const text = displayTextForOpportunity(row);
  const redeemMatch = text.match(/(?:redeem|redemption|赎回)[^\d]{0,18}(\d+(?:\.\d+)?)\s*(?:day|days|天|日)/i);
  if (redeemMatch) {
    const days = Number(redeemMatch[1]);
    if (Number.isFinite(days)) {
      return { lock_label: `赎回 ${Math.round(days)} 天`, lock_type: "locked", lock_days: days };
    }
  }
  const lockDays = parseCampaignDays(text);
  if (Number.isFinite(lockDays) && /fixed|locked|lockup|lock-up|term|duration|定期|固定|锁仓|期限/i.test(text)) {
    return { lock_label: `锁仓 ${Math.round(lockDays)} 天`, lock_type: "locked", lock_days: lockDays };
  }
  if (/flexible|simple earn|soft staking|活期|灵活|no lock|无锁|redeem anytime|随时赎回/i.test(text)) {
    return { lock_label: "无锁仓", lock_type: "flexible", lock_days: null };
  }
  return { lock_label: "锁仓待核验", lock_type: "unknown", lock_days: null };
}

function buildCampaignTimeLeft(row = {}, urgency = {}) {
  const hasHoursLeft = urgency.hours_left !== null && urgency.hours_left !== undefined && urgency.hours_left !== "";
  const hoursLeft = hasHoursLeft ? Number(urgency.hours_left) : Number.NaN;
  if (Number.isFinite(hoursLeft)) {
    if (hoursLeft < 0) return "已过期";
    if (hoursLeft < 24) return `还剩 ${Math.max(1, Math.ceil(hoursLeft))} 小时`;
    if (hoursLeft > 24 * 90) return "长期";
    return `还剩 ${Math.ceil(hoursLeft / 24)} 天`;
  }
  if (row.deadline_source === "no_fixed_deadline") return "长期";
  return "截止待确认";
}

function buildCampaignEstimatedReturn(row = {}, yieldProfile = {}, urgency = {}, lockDays = null) {
  const apy = Number(yieldProfile.eligible_apy ?? yieldProfile.max_apy ?? row.apy);
  if (!Number.isFinite(apy) || apy <= 0) {
    return {
      estimated_return_label: "收益需核验",
      estimated_return_usd: null,
      estimate_period_days: null,
      estimate_basis: "unknown"
    };
  }

  const principal = 10_000;
  const hasHoursLeft = urgency.hours_left !== null && urgency.hours_left !== undefined && urgency.hours_left !== "";
  const hoursLeft = hasHoursLeft ? Number(urgency.hours_left) : Number.NaN;
  let days = null;
  let basis = "预期一个月";
  let amount = principal * (apy / 100) / 12;

  if (Number.isFinite(lockDays) && lockDays > 0) {
    days = lockDays;
    basis = `${Math.round(lockDays)} 天锁仓`;
    amount = principal * (apy / 100) * (lockDays / 365);
  } else if (Number.isFinite(hoursLeft) && hoursLeft > 0 && hoursLeft <= 24 * 90) {
    days = Math.max(1, hoursLeft / 24);
    basis = `${Math.ceil(days)} 天到期`;
    amount = principal * (apy / 100) * (days / 365);
  }

  const estimated = Math.round(amount * 100) / 100;
  return {
    estimated_return_label: `$10,000 本金预期收益 $${estimated.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}（${basis}）`,
    estimated_return_usd: estimated,
    estimate_period_days: days,
    estimate_basis: basis
  };
}

function buildOpportunityCampaignProfile(row = {}, yieldProfile = {}, urgency = {}) {
  const eventType = inferCampaignEventType(row);
  const quota = parseCampaignQuota(row);
  const lock = parseCampaignLock(row);
  const estimate = buildCampaignEstimatedReturn(row, yieldProfile, urgency, lock.lock_days);
  return {
    event_type: eventType,
    platform_path: buildCampaignPlatformPath(row, eventType),
    quota_label: quota.quota_label,
    quota_type: quota.quota_type,
    payout_label: parseCampaignPayout(row),
    lock_label: lock.lock_label,
    lock_type: lock.lock_type,
    lock_days: lock.lock_days,
    time_left_label: buildCampaignTimeLeft(row, urgency),
    ...estimate
  };
}

function maxOpportunityApy(item) {
  const candidates = [
    item.yield_profile?.max_apy,
    item.apy,
    parseMaxApyPercent(item)
  ]
    .map(Number)
    .filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : null;
}

function parseUsdReward(text) {
  const normalized = String(text || "").replace(/,/g, "");
  const matches = [
    ...normalized.matchAll(/(?:>=|至少|不少于|保底|固定|可得|获得|返|奖励)?\s*(\d+(?:\.\d+)?)\s*(?:U|USDT|USDC|USD|美元)/gi),
    ...normalized.matchAll(/(?:\$|＄)\s*(\d+(?:\.\d+)?)/g)
  ];
  const values = matches.map((match) => Number(match[1])).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function parseTimeCostMinutes(text) {
  const value = String(text || "");
  const minuteMatch = value.match(/(\d+(?:\.\d+)?)\s*(?:分钟|min|mins|minutes)/i);
  if (minuteMatch) return Number(minuteMatch[1]);
  const hourMatch = value.match(/(\d+(?:\.\d+)?)\s*(?:小时|h|hour|hours)/i);
  if (hourMatch) return Number(hourMatch[1]) * 60;
  if (/10\s*分钟|十分钟/.test(value)) return 10;
  if (/2\s*小时|两小时|二小时/.test(value)) return 120;
  return null;
}

function hasDayScaleDuration(text) {
  return /(\d+\s*(?:天|日|days?))|按天|每日|daily|锁仓|定期/i.test(String(text || ""));
}

function isQuickOpportunityType(item, text) {
  if (["launch", "pre_tge", "pre_ipo"].includes(item.type)) return true;
  return /(IPO|IEO|ICO|IDO|Launch|Launchpad|Pre-TGE|Pre-IPO|Pre-token|Pre-listing|Pre-market|打新|新币|认购|申购|预售|上市前)/i.test(text);
}

function hasNewUserTerm(text) {
  return /new users?|new customer|first[-\s]?time|新户|新用户|新客|首次/i.test(String(text || ""));
}

function hasCurrentUserTerm(text) {
  return /existing users?|existing|standard|regular|base|ordinary|all users?|current users?|老用户|现有用户|普通用户|标准|基础|基准|所有用户|全体用户|新老用户|老客|非新户/i.test(
    String(text || "")
  );
}

function hasNewUserOnlyTerm(text) {
  return /new users? only|for new users?|new customer only|new user exclusive|新户限定|新户专属|新用户专享|新客专享|仅限新|只限新|首次专享/i.test(
    String(text || "")
  );
}

function splitOpportunityTextSegments(text) {
  return String(text || "")
    .split(/(?:\s+\/\s+)|[;；。,\n，]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isNewUserOnlyApySegment(text) {
  const value = String(text || "");
  return hasNewUserOnlyTerm(value) || (hasNewUserTerm(value) && !hasCurrentUserTerm(value) && /%|a\.?p\.?y\.?|a\.?p\.?r\.?|annual|年化|收益|利率|rate/i.test(value));
}

function isNewUserOnlyOpportunity(item) {
  const text = displayTextForOpportunity(item);
  const hasNewUserOnlySegment = splitOpportunityTextSegments(text).some(isNewUserOnlyApySegment);
  if (!hasNewUserOnlySegment) return false;
  if (hasCurrentUserTerm(text) && Number.isFinite(parseMaxApyPercent(item))) return false;
  return true;
}

function opportunityYieldValue(item) {
  const candidates = [item.yield_profile?.eligible_apy, item.yield_profile?.max_apy, item.apy]
    .map(Number)
    .filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

const KNOWN_TOKEN_SYMBOLS = [
  "USDGO",
  "USD1",
  "USDC",
  "USDT",
  "SPCX",
  "PRESPCX",
  "PREOPAI",
  "KGEN",
  "TRUST",
  "BLESS",
  "LINEA",
  "WLD",
  "ETH",
  "XAUT",
  "SOL",
  "BNB",
  "BTC"
];

const ACTIVITY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "binance",
  "bitget",
  "bybit",
  "cex",
  "com",
  "crypto",
  "earn",
  "exchange",
  "flexible",
  "for",
  "gate",
  "gateio",
  "io",
  "limited",
  "market",
  "markets",
  "okx",
  "official",
  "reward",
  "rewards",
  "simple",
  "the",
  "to",
  "users",
  "wallet",
  "web3",
  "with",
  "活动",
  "官方",
  "奖励",
  "用户",
  "参与",
  "报名",
  "钱包",
  "交易所"
]);

const GENERIC_ACTIVITY_ASSETS = new Set([
  "AIRDROP",
  "CAMPAIGN",
  "EVENT",
  "FOOTBALL",
  "MARKET",
  "MARKETS",
  "PREDICT",
  "PREDICTION",
  "PREDICTIONMARKETS",
  "REWARD",
  "REWARDS",
  "TASK",
  "TASKS"
]);

function normalizeTokenSymbol(value) {
  const text = String(value || "").toUpperCase();
  if (!text) return "";
  for (const token of KNOWN_TOKEN_SYMBOLS) {
    if (new RegExp(`\\b${token}\\b`, "i").test(text)) return token;
  }
  const compact = text.replace(/[^A-Z0-9]/g, "");
  const wordCount = text
    .split(/[^A-Z0-9]+/)
    .map((word) => word.trim())
    .filter(Boolean).length;
  if (wordCount <= 1 && compact.length >= 2 && compact.length <= 18 && !GENERIC_ACTIVITY_ASSETS.has(compact)) return compact;
  return "";
}

function campaignAssetSymbol(item = {}) {
  const asset = normalizeTokenSymbol(item.asset);
  if (asset) return asset;
  const stablecoin = normalizeTokenSymbol(item.stablecoin);
  if (stablecoin) return stablecoin;
  return normalizeTokenSymbol(`${item.activity_name || ""} ${item.expected_yield || ""} ${item.reward || ""}`);
}

function normalizeActivityWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#]/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !/^\d+$/.test(word) && !ACTIVITY_STOP_WORDS.has(word));
}

function campaignNameSignature(item = {}) {
  const primary = normalizeActivityWords([item.activity_name, item.venue, item.asset].filter(Boolean).join(" "));
  const words = primary.length >= 2 ? primary : normalizeActivityWords(displayTextForOpportunity(item));
  return words.slice(0, 6).join("-");
}

function inferCampaignFamily(item = {}) {
  const text = normalizedOpportunityText(item);
  if (item.type === "stablecoin_earn" || item.display_category === "stablecoin_yield") return "earn";
  if (item.type === "pre_tge" || /pre[-\s]?tge|token generation|代币生成/.test(text)) return "pre_tge";
  if (/football|soccer|world cup|prediction markets?|predict\.?fun|预测|足球/.test(text)) return "football_prediction";
  if (/candy\s*drop|candydrop/.test(text)) return "candydrop";
  if (/candy\s*bomb|candybomb/.test(text)) return "candybomb";
  if (/alpha[\s\S]{0,80}(airdrop|points?|空投|积分)|(airdrop|空投)[\s\S]{0,80}alpha/.test(text)) return "alpha_airdrop";
  if (/pre[-\s]?ipo|ipo express|tokenized shares?|stocks? perps?|perpetual|pre[-\s]?market|pre[-\s]?token|pre[-\s]?listing|上市前|预上市|股份|认购/.test(text)) {
    if (/perps?|perpetual|futures?|合约|永续/.test(text)) return "pre_ipo_perps";
    if (/ipo express|tokenized shares?|stock|stocks|股份|认购/.test(text)) return "ipo_express";
    return "pre_ipo";
  }
  if (/launchpad|launchpool|startup|jumpstart|poolx|megadrop|hodler|ieo|ido|ico|打新|新币|申购/.test(text)) return "launch";
  if (/xstocks?|tokenized stock|股票代币/.test(text)) return "xstocks_campaign";
  if (/convert challenge|convert.*challenge|闪兑.*挑战|兑换.*挑战/.test(text)) return "convert_challenge";
  if (/cryptopedia|learn.?to.?earn|fan club|task campaign|任务/.test(text)) return "task_campaign";
  if (/points?|airdrop|multiplier|积分|空投/.test(text)) return "points_airdrop";
  if (item.section === "onchain" && /vault|farm|lp|liquidity|staking|池|金库|流动性/.test(text)) return "vault_yield";
  if (/prediction|predict|预测/.test(text)) return "prediction";
  const fallback = item.type || item.display_category || inferCampaignEventType(item);
  return String(fallback || "activity")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function campaignDedupeSubject(item = {}, family = inferCampaignFamily(item)) {
  const asset = campaignAssetSymbol(item);
  const stablecoin = normalizeTokenSymbol(item.stablecoin);
  const text = normalizedOpportunityText(item);
  if (family === "earn" && asset) return { subject: asset, basis: "asset" };
  if (family === "football_prediction") return { subject: "football", basis: "event_theme" };
  if (asset && asset !== stablecoin && !GENERIC_ACTIVITY_ASSETS.has(asset)) {
    return { subject: asset, basis: "asset" };
  }
  if (/space\s*x|spacex/.test(text)) return { subject: "spacex", basis: "event_theme" };
  if (/openai|open ai/.test(text)) return { subject: "openai", basis: "event_theme" };
  const signature = campaignNameSignature(item);
  return signature ? { subject: signature, basis: "name_signature" } : { subject: "", basis: "none" };
}

function canonicalOpportunityPlatform(item = {}) {
  const text = String(item.exchange || item.venue || "").toLowerCase();
  if (!text) return "";
  if (text.includes("binance")) return "binance";
  if (text.includes("bitget")) return "bitget";
  if (text.includes("gate")) return "gate";
  if (text.includes("bybit")) return "bybit";
  if (text.includes("okx")) return "okx";
  return text.replace(/\b(exchange|earn|finance|wallet|web3|app|\.io|\.com)\b/g, "").replace(/[^a-z0-9]+/g, "");
}

function opportunityDedupKey(item = {}) {
  const platform = canonicalOpportunityPlatform(item);
  if (!platform) return null;
  const family = inferCampaignFamily(item);
  const { subject } = campaignDedupeSubject(item, family);
  if (!subject) return null;
  const eventType = item.campaign_profile?.event_type || inferCampaignEventType(item);
  return ["activity", platform, family, subject, eventType].join("|").toLowerCase();
}

function duplicateRepresentativeRank(item = {}) {
  const displayRank = ({ stablecoin_yield: 0, quick_opportunity: 1, watch_opportunity: 2 })[item.display_category] ?? 3;
  const reviewRank = item.review?.label === "可参与" ? 0 : item.review?.label === "待核验" ? 1 : item.review?.label === "观察项" ? 2 : 3;
  const credibilityRank = item.credibility === "official" ? 0 : item.credibility === "kol" ? 1 : 2;
  const platform = canonicalOpportunityPlatform(item);
  const sourceUser = String(item.source_user || "").toLowerCase();
  const sourceHandle = sourceUser.replace(/^@/, "");
  const sourceRank = platform && sourceHandle === platform ? 0 : platform && sourceHandle.includes(platform) ? 1 : 2;
  const officialRank = item.official_url ? 0 : 1;
  const timestamp = Date.parse(item.source_published_at || item.first_seen_at || item.last_seen_at || "");
  return [
    displayRank,
    reviewRank,
    credibilityRank,
    sourceRank,
    officialRank,
    -Number(item.data_quality?.score || 0),
    -opportunityYieldValue(item),
    -(Number.isFinite(timestamp) ? timestamp : 0)
  ];
}

function compareDuplicateRepresentative(a, b) {
  const left = duplicateRepresentativeRank(a);
  const right = duplicateRepresentativeRank(b);
  for (let index = 0; index < left.length; index += 1) {
    const diff = left[index] - right[index];
    if (diff) return diff;
  }
  return String(a.activity_name || "").localeCompare(String(b.activity_name || ""));
}

function uniqueCompact(values, limit = 8) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

function buildDuplicateAnalysis(representative = {}, dedupKey = null) {
  const family = inferCampaignFamily(representative);
  const { subject, basis } = campaignDedupeSubject(representative, family);
  return {
    platform: canonicalOpportunityPlatform(representative),
    family,
    subject,
    match_basis: basis,
    event_type: representative.campaign_profile?.event_type || inferCampaignEventType(representative),
    dedup_scope: dedupKey ? "platform_family_subject" : "single_source"
  };
}

function buildDuplicateProfile(group, dedupKey) {
  const apyValues = uniqueCompact(
    group
      .map((item) => opportunityYieldValue(item))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Number(value.toFixed(4)))
  ).map(Number);
  const minApy = apyValues.length ? Math.min(...apyValues) : null;
  const maxApy = apyValues.length ? Math.max(...apyValues) : null;
  const apyRangeLabel =
    Number.isFinite(minApy) && Number.isFinite(maxApy)
      ? minApy === maxApy
        ? `${maxApy}% APY`
        : `${minApy}-${maxApy}% APY`
      : "";
  return {
    dedup_key: dedupKey,
    source_count: group.length,
    merged_count: Math.max(0, group.length - 1),
    source_users: uniqueCompact(group.map((item) => item.source_user), 10),
    source_urls: uniqueCompact(group.map((item) => item.source_url), 10),
    activity_names: uniqueCompact(group.map((item) => item.activity_name), 10),
    apy_values: apyValues,
    apy_range_label: apyRangeLabel,
    analysis: buildDuplicateAnalysis(group[0], dedupKey)
  };
}

function activeDuplicateYieldValue(group) {
  const values = group
    .filter((item) => item.status === "active" && item.display_category !== "watch_opportunity")
    .map(opportunityYieldValue)
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : null;
}

function applyDuplicateYieldProfile(representative, group, profile) {
  const activeMaxApy = activeDuplicateYieldValue(group);
  const representativeApy = opportunityYieldValue(representative);
  if (!Number.isFinite(activeMaxApy) || activeMaxApy <= representativeApy) {
    return {
      ...representative,
      duplicate_profile: profile
    };
  }
  const asset = campaignAssetSymbol(representative) || representative.stablecoin || representative.asset || "资产";
  const qualifiers = [...new Set([...(representative.yield_profile?.qualifiers || []), "多来源最高"])];
  return {
    ...representative,
    display_reason:
      representative.display_category === "stablecoin_yield"
        ? `${asset} APY ${activeMaxApy}%`
        : representative.display_reason,
    yield_profile: {
      ...(representative.yield_profile || {}),
      max_apy: activeMaxApy,
      eligible_apy: activeMaxApy,
      max_apy_source: "merged_active_sources",
      qualifiers,
      summary: `${representative.yield_profile?.label || "收益"}：${qualifiers.join("、")}`
    },
    duplicate_profile: {
      ...profile,
      active_max_apy: activeMaxApy
    }
  };
}

function mergeDuplicateOpportunities(items) {
  const groups = new Map();
  const unique = [];
  for (const item of items) {
    const key = opportunityDedupKey(item);
    if (!key) {
      unique.push({
        ...item,
        duplicate_profile: buildDuplicateProfile([item], null)
      });
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const duplicateExamples = [];
  for (const [key, group] of groups.entries()) {
    if (group.length === 1) {
      unique.push({
        ...group[0],
        duplicate_profile: buildDuplicateProfile(group, key)
      });
      continue;
    }
    const representative = [...group].sort(compareDuplicateRepresentative)[0];
    const profile = buildDuplicateProfile(group, key);
    duplicateExamples.push({
      activity_name: representative.activity_name,
      exchange: representative.exchange || representative.venue || "",
      asset: campaignAssetSymbol(representative),
      family: profile.analysis.family,
      match_basis: profile.analysis.match_basis,
      source_count: profile.source_count,
      source_users: profile.source_users,
      apy_range_label: profile.apy_range_label
    });
    unique.push(applyDuplicateYieldProfile(representative, group, profile));
  }

  return {
    items: unique,
    duplicate_group_count: [...groups.values()].filter((group) => group.length > 1).length,
    duplicate_item_count: [...groups.values()].reduce((sum, group) => sum + Math.max(0, group.length - 1), 0),
    duplicate_examples: duplicateExamples.slice(0, 12)
  };
}

function evaluateOpportunityDisplay(item) {
  if (item.yield_profile?.new_user_only) {
    return { ok: false, exclude: true, reason: "新户限定，已按非新用户过滤" };
  }

  if (item.status !== "active") {
    return { ok: false, reason: "非 active 状态" };
  }

  const text = displayTextForOpportunity(item);
  const excludedPattern = EXCLUDED_OPPORTUNITY_PATTERNS.find((pattern) => pattern.test(text));
  if (excludedPattern) {
    return { ok: false, reason: "排除邀请、交易量竞赛、排名、抽奖或纯任务活动" };
  }

  const stablecoin = String(item.stablecoin || item.asset || "").toUpperCase();
  const maxApy = maxOpportunityApy(item);
  if (DISPLAY_STABLECOINS.has(stablecoin) && Number.isFinite(maxApy) && maxApy > 10) {
    return {
      ok: true,
      category: "stablecoin_yield",
      reason: `${stablecoin} APY ${maxApy}%`
    };
  }

  if (!isQuickOpportunityType(item, text)) {
    return { ok: false, reason: "不属于稳定币高息或 IPO/IEO/ICO/Launch 短期机会" };
  }

  if (hasDayScaleDuration(text)) {
    if (Number.isFinite(maxApy) && maxApy > 10) {
      return {
        ok: true,
        category: "quick_opportunity",
        reason: `按天机会，年化 ${maxApy}%`
      };
    }
    return { ok: false, reason: "按天完成但缺少大于 10% 的可计算年化" };
  }

  const rewardUsd = parseUsdReward(text);
  const timeCostMinutes = parseTimeCostMinutes(text);
  if (!Number.isFinite(rewardUsd) || !Number.isFinite(timeCostMinutes)) {
    return { ok: false, reason: "缺少个人可得收益或时间成本" };
  }
  if (timeCostMinutes <= 10 && rewardUsd >= 10) {
    return {
      ok: true,
      category: "quick_opportunity",
      reason: `预计 ${Math.round(timeCostMinutes)} 分钟，个人收益约 ${rewardUsd}U`
    };
  }
  if (timeCostMinutes <= 120 && rewardUsd >= 50) {
    return {
      ok: true,
      category: "quick_opportunity",
      reason: `预计 ${Math.round(timeCostMinutes)} 分钟，个人收益约 ${rewardUsd}U`
    };
  }
  return { ok: false, reason: "短期收益未达到时间成本门槛" };
}

function applyOpportunityDisplayFilter(items) {
  const kept = [];
  const watch = [];
  const excluded = [];
  for (const item of items) {
    const evaluation = evaluateOpportunityDisplay(item);
    if (evaluation.exclude) {
      excluded.push({
        activity_name: item.activity_name,
        type: item.type,
        section: item.section,
        exchange: item.exchange || "",
        venue: item.venue || "",
        reason: evaluation.reason
      });
      continue;
    }
    if (evaluation.ok) {
      kept.push({
        ...item,
        display_category: evaluation.category,
        display_reason: evaluation.reason
      });
    } else {
      watch.push({
        activity_name: item.activity_name,
        type: item.type,
        section: item.section,
        exchange: item.exchange || "",
        venue: item.venue || "",
        reason: evaluation.reason
      });
      kept.push({
        ...item,
        review:
          item.review?.label === "可参与"
            ? {
                ...item.review,
                label: "观察项",
                tone: "info",
                reason: evaluation.reason
              }
            : item.review,
        display_category: "watch_opportunity",
        display_reason: evaluation.reason
      });
    }
  }
  const deduped = mergeDuplicateOpportunities(kept);
  const dedupedWatch = deduped.items.filter((item) => item.display_category === "watch_opportunity");
  return {
    items: deduped.items,
    summary: {
      input_count: items.length,
      kept_count: deduped.items.length,
      pre_dedup_kept_count: kept.length,
      excluded_count: excluded.length,
      excluded_new_user_count: excluded.filter((item) => item.reason.includes("新户限定")).length,
      watch_count: dedupedWatch.length,
      stablecoin_yield_count: deduped.items.filter((item) => item.display_category === "stablecoin_yield").length,
      quick_opportunity_count: deduped.items.filter((item) => item.display_category === "quick_opportunity").length,
      duplicate_group_count: deduped.duplicate_group_count,
      duplicate_item_count: deduped.duplicate_item_count,
      excluded_examples: excluded.slice(0, 12),
      watch_examples: watch.slice(0, 12),
      duplicate_examples: deduped.duplicate_examples
    }
  };
}

function buildStablecoinSummary(items) {
  const rows = items.filter((item) => item.display_category === "stablecoin_yield" && item.status !== "unverified");
  const byCoin = {};
  const bySection = { cex: 0, onchain: 0 };
  let highest = null;

  for (const item of rows) {
    const coin = String(item.stablecoin || item.asset || "UNKNOWN").toUpperCase();
    byCoin[coin] = (byCoin[coin] || 0) + 1;
    const section = item.section === "onchain" ? "onchain" : "cex";
    bySection[section] = (bySection[section] || 0) + 1;
    const apy = opportunityYieldValue(item);
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
  if (item.type === "pre_ipo" || item.type === "pre_tge") score += 20;
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
  if (row.type === "pre_tge") {
    score = Math.max(score, 4);
    reasons.push("Pre-TGE/资格与代币兑现风险");
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
  const newUserOnly = isNewUserOnlyOpportunity(row);
  const hasNewUserTier = hasNewUserTerm(text);
  const hasCurrentUserTier = hasCurrentUserTerm(text);
  const baseApy = !newUserOnly && Number.isFinite(Number(row.apy)) ? Number(row.apy) : null;
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
  if (newUserOnly) {
    qualifiers.push("新户限定");
    tone = tone === "risk" ? tone : "warn";
  } else if (hasNewUserTier && hasCurrentUserTier) {
    qualifiers.push("含新户档");
    tone = tone === "risk" ? tone : "info";
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
  const hasFixedTerm = /fixed|定期|固定/.test(text) && !/no fixed|无固定|非固定|不固定|活期|flexible|no lock|无锁/.test(text);
  if (hasFixedTerm && !qualifiers.includes("浮动利率")) {
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
  if (row.type === "pre_tge") {
    qualifiers.push("非 APY 收益");
    label = "Pre-TGE 资格/份额";
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
    eligible_apy: Number.isFinite(maxApy) ? maxApy : null,
    max_apy_source: maxApySource,
    new_user_only: newUserOnly,
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
  } else if (row.type === "pre_tge") {
    text = `进入 ${venue} 官方 Pre-TGE 活动入口，按公告完成白名单、积分、快照、预存款或社区销售要求，先核验 TGE 时间、资格与代币解锁规则。`;
    steps = [
      `打开 ${venue} 官方 Pre-TGE 或公告入口`,
      "确认白名单、积分、快照、预存款或销售资格要求",
      "核验 TGE、代币发放、解锁、女巫过滤和地区限制"
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
  return rows.map((row) => {
    const urgency = buildOpportunityUrgency(row, now);
    const yieldProfile = buildOpportunityYieldProfile(row);
    return {
      ...row,
      data_quality: buildOpportunityQuality(row),
      review: buildOpportunityReview(row),
      urgency,
      freshness: buildOpportunityFreshness(row, now),
      risk_profile: buildOpportunityRisk(row),
      yield_profile: yieldProfile,
      campaign_profile: buildOpportunityCampaignProfile(row, yieldProfile, urgency),
      participation_guidance: buildOpportunityParticipationGuidance(row)
    };
  });
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
  const displayRank = (item) => ({ stablecoin_yield: 0, quick_opportunity: 1, watch_opportunity: 2 })[item.display_category] ?? 3;
  const typeRank = (item) =>
    ({ pre_tge: 0, launch: 1, stablecoin_earn: 2, pre_ipo: 3, short_term: 4, onchain: 5 })[item.type] ?? 6;
  return (
    displayRank(a) - displayRank(b) ||
    opportunityYieldValue(b) - opportunityYieldValue(a) ||
    reviewRank(a) - reviewRank(b) ||
    urgencyRank(a) - urgencyRank(b) ||
    freshnessRank(a) - freshnessRank(b) ||
    typeRank(a) - typeRank(b) ||
    String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || ""))
  );
}

function getDisplayOpportunityItems(db, config) {
  const rawItems =
    db.getDisplayOpportunities?.(config.opportunityStaleAfterHours) ||
    db.getActiveOpportunities?.(config.opportunityStaleAfterHours) ||
    [];
  const enriched = attachOpportunityQuality(rawItems, new Date());
  return applyOpportunityDisplayFilter(enriched).items.sort(compareOpportunityDisplay);
}

function getDisplayOpportunityPayload(db, config) {
  const rawItems =
    db.getDisplayOpportunities?.(config.opportunityStaleAfterHours) ||
    db.getActiveOpportunities?.(config.opportunityStaleAfterHours) ||
    [];
  const enriched = attachOpportunityQuality(rawItems, new Date());
  const payload = applyOpportunityDisplayFilter(enriched);
  payload.items.sort(compareOpportunityDisplay);
  return payload;
}

function parseSecuritySkipReasons(detail = "") {
  const matched = String(detail || "").match(/skip_reasons=(\{.*?\})(?:\s|$)/);
  if (!matched) return {};
  try {
    return JSON.parse(matched[1]);
  } catch {
    return {};
  }
}

function buildSecurityIncidentPayload(db, getSecurityIncidentStatus) {
  const monitor = getSecurityIncidentStatus?.() || { enabled: false, running: false };
  const items = db.getSecurityIncidents?.(20) || [];
  const summary =
    db.getSecurityIncidentSummary?.() || {
      total: items.length,
      critical: items.filter((item) => item.alert_level === "critical").length,
      anomaly: items.filter((item) => item.alert_level === "anomaly").length,
      watch: items.filter((item) => item.alert_level === "watch").length,
      pushed: items.filter((item) => item.anomaly_pushed_at || item.critical_pushed_at).length
    };
  const health = db.getRecentHealth?.("security_incident_monitor", 10) || [];
  const skipReasons = health.reduce((acc, row) => {
    const reasons = parseSecuritySkipReasons(row.detail);
    for (const [key, count] of Object.entries(reasons)) {
      acc[key] = (acc[key] || 0) + Number(count || 0);
    }
    return acc;
  }, {});

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    monitor,
    summary,
    latest_health: health[0] || null,
    recent_health: health,
    skip_reasons: skipReasons,
    items
  };
}

function buildOpportunitiesPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>高收益机会看板</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #050509;
      --panel: #0c0c12;
      --panel-strong: #12121b;
      --text: #f7f1ff;
      --muted: #a99bb8;
      --line: #2d2135;
      --line-hot: #ff2f92;
      --accent: #ff2f92;
      --accent-soft: rgba(255, 47, 146, 0.16);
      --warn: #ffd166;
      --warn-soft: rgba(255, 209, 102, 0.15);
      --risk: #ff4d6d;
      --risk-soft: rgba(255, 77, 109, 0.16);
      --info: #72f7ff;
      --info-soft: rgba(114, 247, 255, 0.14);
      --ink: #ffffff;
      --shadow-hot: 0 0 0 1px rgba(255, 47, 146, 0.22), 0 18px 42px rgba(0, 0, 0, 0.34);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        linear-gradient(rgba(255, 47, 146, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(114, 247, 255, 0.025) 1px, transparent 1px),
        var(--bg);
      background-size: 28px 28px;
      color: var(--text);
      font-family: "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      letter-spacing: 0;
    }
    header {
      padding: 22px 22px 18px;
      border-bottom: 1px solid var(--line);
      background: rgba(5, 5, 9, 0.96);
      box-shadow: 0 1px 0 rgba(255, 47, 146, 0.16);
    }
    .hero {
      max-width: 1180px;
      margin: 0 auto;
    }
    .hero-top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: start;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      line-height: 1.2;
      font-weight: 700;
      color: var(--ink);
      text-shadow: 0 0 18px rgba(255, 47, 146, 0.55);
    }
    .subtitle {
      margin: 0;
      max-width: 760px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0;
      justify-content: flex-end;
    }
    .action-link {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 9px;
      background: #101019;
      color: var(--accent);
      font-size: 13px;
      font-weight: 700;
      box-shadow: inset 0 0 0 1px rgba(255, 47, 146, 0.08);
    }
    .action-link:hover {
      border-color: var(--accent);
      background: var(--accent-soft);
      text-decoration: none;
    }
    .status {
      display: grid;
      grid-template-columns: repeat(4, minmax(150px, 1fr));
      gap: 10px;
      max-width: 1180px;
    }
    .ops-panel .status {
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: linear-gradient(180deg, #12121b 0%, #0b0b11 100%);
      padding: 10px 12px;
      min-width: 0;
      box-shadow: inset 0 0 0 1px rgba(255, 47, 146, 0.06);
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
      color: var(--accent);
    }
    main {
      padding: 14px 22px 28px;
      max-width: 1224px;
      margin: 0 auto;
    }
    .section-head {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      margin: 12px 0 10px;
    }
    .section-head h2 {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
    }
    .section-head p {
      margin: 4px 0 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .opportunity-list {
      display: grid;
      gap: 10px;
      margin-bottom: 14px;
    }
    .opportunity-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 14px;
      min-width: 0;
      box-shadow: var(--shadow-hot);
    }
    .opportunity-card h3 {
      margin: 0 0 8px;
      font-size: 16px;
      line-height: 1.35;
    }
    .opportunity-row {
      display: grid;
      grid-template-columns: minmax(220px, 1.2fr) minmax(180px, 0.75fr) minmax(240px, 1fr) minmax(220px, 0.9fr);
      gap: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: linear-gradient(180deg, rgba(18, 18, 27, 0.98), rgba(9, 9, 14, 0.98));
      padding: 14px;
      min-width: 0;
      box-shadow: var(--shadow-hot);
    }
    .opportunity-row:hover {
      border-color: rgba(255, 47, 146, 0.62);
      box-shadow: 0 0 0 1px rgba(255, 47, 146, 0.42), 0 0 30px rgba(255, 47, 146, 0.14);
    }
    .row-title h3 {
      margin: 0 0 8px;
      font-size: 16px;
      line-height: 1.35;
      color: var(--ink);
    }
    .row-block {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .row-label {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .card-meta,
    .card-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin: 7px 0;
    }
    .card-text {
      margin: 8px 0 0;
      color: var(--text);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .card-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .source-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 10px;
      font-size: 13px;
    }
    .ops-panel {
      margin-top: 18px;
      border-top: 1px solid var(--line);
      padding-top: 14px;
    }
    details.ops-panel summary {
      cursor: pointer;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 12px;
    }
    .tabs {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 10px;
      margin-bottom: 4px;
    }
    .filter-bar {
      display: grid;
      grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 10px;
      align-items: end;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(12, 12, 18, 0.96);
      padding: 10px;
      margin: 0 0 12px;
      box-shadow: inset 0 0 0 1px rgba(114, 247, 255, 0.05);
    }
    .filter-control {
      min-width: 0;
    }
    .filter-control label {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .filter-control select {
      width: 100%;
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #090910;
      color: var(--text);
      padding: 6px 9px;
      font: inherit;
      outline: none;
    }
    .filter-control select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(255, 47, 146, 0.16);
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
      background: var(--panel-strong);
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
      background: #0c0c12;
      color: var(--text);
      padding: 8px 10px;
      min-height: 34px;
      white-space: nowrap;
      cursor: pointer;
    }
    .tab.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--ink);
      font-weight: 700;
      box-shadow: 0 0 16px rgba(255, 47, 146, 0.18);
    }
    .table-wrap {
      overflow: visible;
      border: 0;
      background: transparent;
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
      background: #11111a;
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
      background: #161622;
      color: #d8cee5;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .tag.apy { background: var(--accent-soft); color: #ff8cc6; border-color: rgba(255, 47, 146, 0.38); font-weight: 700; }
    .tag.warn { background: var(--warn-soft); color: var(--warn); }
    .tag.risk { background: var(--risk-soft); color: var(--risk); }
    .tag.info { background: var(--info-soft); color: var(--info); }
    .tag.hot { background: rgba(255, 47, 146, 0.22); color: #ffc1df; border-color: rgba(255, 47, 146, 0.48); }
    .empty {
      padding: 26px;
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    @media (max-width: 760px) {
      header, main { padding-left: 12px; padding-right: 12px; }
      .hero-top { grid-template-columns: 1fr; }
      .actions { justify-content: flex-start; }
      .status { grid-template-columns: 1fr 1fr; }
      .filter-bar { grid-template-columns: 1fr 1fr; }
      h1 { font-size: 24px; }
      .opportunity-row { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      .filter-bar { grid-template-columns: 1fr; }
      .status { grid-template-columns: 1fr; }
      .actions { width: 100%; }
      .action-link { flex: 1; justify-content: center; }
      .section-head { align-items: start; }
      .opportunity-row { padding: 12px; gap: 10px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="hero">
      <div class="hero-top">
        <div>
          <h1>高收益机会看板</h1>
          <p class="subtitle">按当前用户可参与 APY 从高到低排序；新户专属活动默认过滤，含新户档的活动只按老用户/普通用户收益展示。</p>
        </div>
        <div class="actions">
          <a class="action-link" href="/api/opportunities/export.csv">导出 CSV</a>
          <a class="action-link" href="/api/opportunities" target="_blank" rel="noreferrer">JSON API</a>
        </div>
      </div>
      <section class="status">
        <div class="metric"><span>当前机会</span><strong id="totalCount">0</strong></div>
        <div class="metric"><span>稳定币最高</span><strong id="stablecoinTop">加载中</strong></div>
        <div class="metric"><span>短期机会</span><strong id="shortTermCount">加载中</strong></div>
        <div class="metric"><span>最近更新</span><strong id="lastRun">加载中</strong></div>
      </section>
    </div>
  </header>
  <main>
    <nav class="tabs" id="tabs" data-default-excludes-unverified="true"></nav>
    <section class="filter-bar" id="filterBar" aria-label="活动筛选"></section>
    <section id="content" class="table-wrap"></section>
    <details class="ops-panel">
      <summary>采集状态与数据质量</summary>
      <section class="status">
        <div class="metric"><span>下次采集</span><strong id="nextRun">加载中</strong></div>
        <div class="metric"><span>采集状态</span><strong id="runStatus">加载中</strong></div>
        <div class="metric"><span>CEX覆盖</span><strong id="coverageQuality">加载中</strong></div>
        <div class="metric"><span>下轮查询</span><strong id="queryPlanSummary">加载中</strong></div>
        <div class="metric"><span>新鲜度</span><strong id="freshnessQuality">加载中</strong></div>
        <div class="metric"><span>截止质量</span><strong id="deadlineQuality">加载中</strong></div>
        <div class="metric"><span>官方链接</span><strong id="officialQuality">加载中</strong></div>
        <div class="metric"><span>资料完整度</span><strong id="dataQuality">加载中</strong></div>
        <div class="metric"><span>待补字段</span><strong id="fieldGapQuality">加载中</strong></div>
        <div class="metric"><span>补查队列</span><strong id="enrichmentBacklogMetric">加载中</strong></div>
        <div class="metric"><span>采集诊断</span><strong id="diagnosticStatus">加载中</strong></div>
        <div class="metric"><span>安全事件</span><strong id="securityIncidentMetric">加载中</strong></div>
        <div class="metric"><span>任务明细</span><strong id="jobStatsSummary">加载中</strong></div>
        <div class="metric"><span>观察项</span><strong id="watchCount">加载中</strong></div>
        <div class="metric"><span>高风险</span><strong id="highRiskCount">加载中</strong></div>
      </section>
      <section id="stablecoinSummary" class="coverage"></section>
      <section id="coverage" class="coverage"></section>
      <section id="queryPlan" class="coverage"></section>
      <section id="runHistory" class="coverage"></section>
      <section id="jobStats" class="coverage"></section>
      <section id="diagnostics" class="coverage"></section>
      <section id="securityIncidents" class="coverage"></section>
      <section id="fieldGaps" class="coverage"></section>
      <section id="enrichmentBacklog" class="coverage"></section>
    </details>
  </main>
  <script>
    const tabDefs = [
      ["all", "全部"],
      ["stablecoin_yield", "稳定币高息"],
      ["quick_opportunity", "短期机会"],
      ["watch_opportunity", "观察项"],
      ["cex", "CEX"],
      ["onchain", "链上/DEX"],
      ["urgent", "即将截止"]
    ];
    const displayCategoryLabels = {
      stablecoin_yield: "稳定币高息",
      quick_opportunity: "短期机会",
      watch_opportunity: "观察项"
    };
    let state = {
      activeTab: "all",
      exchangeFilter: "all",
      quotaFilter: "all",
      lockFilter: "all",
      sortMode: "apy",
      items: [],
      coverage: null,
      queryPlan: null,
      stablecoinSummary: null,
      recentRuns: [],
      fieldGaps: null,
      enrichmentBacklog: null,
      diagnostics: null,
      securityIncidents: null,
      latestRun: null,
      runHealth: null,
      monitor: null,
      displayFilter: null
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
        pre_tge: "Pre-TGE",
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
        [/USD1 Simple Earn 灵活/gi, "USD1 简单赚币灵活理财"],
        [/Binance App 或网页 -> Earn -> Simple Earn -> 搜索 USD1 -> 选择 灵活 产品认购/gi, "打开 Binance App 或网页，进入 Earn / Simple Earn，搜索 USD1，选择灵活理财产品认购"],
        [/New users: deposit \\$10 \\+ trade \\$10 spot \\(get 5 USDT\\); all users: trade SPCXUSDT Perps min 1,000 USDT vol to share 150,000 USDT pool/gi, "新用户充值 10 美元并完成 10 美元现货交易可得 5 USDT；所有用户交易 SPCXUSDT 永续，成交量至少 1,000 USDT 后可瓜分 150,000 USDT 奖池"],
        [/OKX Web3 Wallet \\/ DEX trade eligible xStocks \\(TSLAx, AAPLx etc\\.\\) on Solana, zero fees during event, ranked by volume \\(top 5k share 300k USDC pool\\)/gi, "通过 OKX Web3 钱包/DEX 在 Solana 交易符合条件的 xStocks（如 TSLAx、AAPLx 等）；活动期零手续费，按成交量排名，前 5,000 名瓜分 300,000 USDC 奖池"],
        [/Regional Vietnam campaign via @okx_vietnam; SPCXUSDT is Rebase Pre-IPO Perp \\(SpaceX price discovery\\); trading risk of loss; page may require app\\/login or be geo-restricted/gi, "该活动来自 OKX Vietnam 区域渠道；SPCXUSDT 属于 Rebase Pre-IPO 永续，反映 SpaceX 价格发现预期；交易可能亏损，页面可能需要 App/登录或受地区限制"],
        [/Confirm full terms\\/eligible pairs on the official page; high volume competition likely; onchain Solana risks \\(liquidity, slippage, smart contracts\\)/gi, "需在官方页面核验完整条款和可交易标的；成交量竞赛竞争强；Solana 链上交易存在流动性、滑点和智能合约风险"],
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
      if (item.type === "pre_tge") {
        return localizeText(item.risk_note, "Pre-TGE 存在资格、女巫过滤、TGE 延期、代币解锁和合约风险。");
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
        return "可参与 " + maxApy + "% APY";
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

    function securityIncidentSummaryText(security) {
      const summary = security?.summary;
      if (!summary) return "无数据";
      return "危急 " + Number(summary.critical || 0) + " / 异常 " + Number(summary.anomaly || 0) + " / 观察 " + Number(summary.watch || 0);
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
      const rawName = String(item.activity_name || "");
      if (rawName.includes("USD1") && rawName.includes("Simple Earn") && rawName.includes("灵活")) return "Binance USD1 简单赚币灵活理财";
      if (/OKX\\s+SPCX\\s+Trade-to-Earn/i.test(rawName)) return "OKX SPCX 交易赚取活动";
      if (/OKX\\s+xStocks/i.test(rawName)) return "OKX xStocks 链上交易竞赛";
      const known = {
        "Bybit IPO Express - SpaceX Tokenized Shares": "Bybit IPO Express - SpaceX 代币化股份",
        "Bitget $SPCX SpaceX IPO Pre-Trading & Predict Contest": "Bitget $SPCX SpaceX Pre-IPO 交易与预测活动",
        "Binance Wallet Football Trading Cup": "Binance 钱包足球交易杯",
        "Bybit Football Season 2026 Predict & Earn": "Bybit 2026 足球赛季预测赚取活动",
        "Binance USD1 Simple Earn Flexible": "Binance USD1 灵活理财",
        "Bybit EU Fixed Earn USDC High APR": "Bybit EU USDC 定期高息理财",
        "USD1 Simple Earn 灵活": "Binance USD1 简单赚币灵活理财",
        "Binance Pre-IPO Perps SpaceX/OpenAI Dominance": "Binance Pre-IPO 永续：SpaceX/OpenAI",
        "OKX SPCX Trade-to-Earn 活动": "OKX SPCX 交易赚取活动",
        "OKX xStocks 交易竞赛": "OKX xStocks 链上交易竞赛"
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

    function yieldSortValue(item) {
      const values = [item.yield_profile?.eligible_apy, item.yield_profile?.max_apy, item.apy]
        .map(Number)
        .filter(Number.isFinite);
      return values.length ? Math.max.apply(null, values) : 0;
    }

    function displaySortRank(item) {
      const ranks = { stablecoin_yield: 0, quick_opportunity: 1, watch_opportunity: 2 };
      return ranks[item.display_category] ?? 3;
    }

    function deadlineSortValue(item) {
      const deadline = Date.parse(item.deadline_at || "");
      return Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    }

    function sortByYieldDesc(items) {
      return [...items].sort((a, b) =>
        displaySortRank(a) - displaySortRank(b) ||
        yieldSortValue(b) - yieldSortValue(a) ||
        String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || ""))
      );
    }

    function sortByDeadlineAsc(items) {
      return [...items].sort((a, b) =>
        displaySortRank(a) - displaySortRank(b) ||
        deadlineSortValue(a) - deadlineSortValue(b) ||
        yieldSortValue(b) - yieldSortValue(a) ||
        String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || ""))
      );
    }

    function defaultItems() {
      return state.sortMode === "deadline" ? sortByDeadlineAsc(state.items) : sortByYieldDesc(state.items);
    }

    function tabItems(items) {
      if (state.activeTab === "all") return items;
      if (state.activeTab === "urgent") {
        return items.filter((item) => item.urgency?.level === "urgent" || item.urgency?.level === "soon");
      }
      if (state.activeTab === "cex") return items.filter((item) => item.section !== "onchain");
      if (state.activeTab === "onchain") return items.filter((item) => item.section === "onchain");
      return items.filter((item) => item.display_category === state.activeTab);
    }

    function matchesToolbarFilters(item) {
      if (state.exchangeFilter !== "all") {
        if (state.exchangeFilter === "__onchain") {
          if (item.section !== "onchain") return false;
        } else {
          const venue = String(item.exchange || item.venue || "").toLowerCase();
          if (!venue.includes(state.exchangeFilter.toLowerCase())) return false;
        }
      }

      const campaign = item.campaign_profile || {};
      if (state.quotaFilter !== "all" && campaign.quota_type !== state.quotaFilter) return false;
      if (state.lockFilter === "flexible" && campaign.lock_type !== "flexible") return false;
      if (state.lockFilter === "locked" && campaign.lock_type !== "locked") return false;
      if (state.lockFilter === "unknown" && campaign.lock_type !== "unknown") return false;
      return true;
    }

    function filteredItems() {
      return tabItems(defaultItems()).filter(matchesToolbarFilters);
    }

    function renderTabs() {
      const tabs = document.getElementById("tabs");
      const baseItems = defaultItems();
      tabs.innerHTML = tabDefs.map(([id, label]) => {
        const count = id === "all" ? baseItems.length
          : id === "urgent"
          ? baseItems.filter((item) => item.urgency?.level === "urgent" || item.urgency?.level === "soon").length
          : id === "cex"
            ? baseItems.filter((item) => item.section !== "onchain").length
          : id === "onchain"
            ? baseItems.filter((item) => item.section === "onchain").length
          : baseItems.filter((item) => item.display_category === id).length;
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

    function exchangeOptions(items) {
      const preferred = ["Binance", "OKX", "Bybit", "Gate", "Bitget"];
      const values = new Set(
        items
          .filter((item) => item.section !== "onchain")
          .map((item) => item.exchange || item.venue)
          .filter(Boolean)
      );
      const ordered = [
        ...preferred.filter((name) => values.has(name)),
        ...[...values].filter((name) => !preferred.includes(name)).sort((a, b) => a.localeCompare(b))
      ];
      return [
        ["all", "全部交易所"],
        ...ordered.map((name) => [name, name]),
        ["__onchain", "链上/DEX"]
      ];
    }

    function selectHtml(id, label, value, options) {
      return '<div class="filter-control"><label for="' + escapeHtml(id) + '">' + escapeHtml(label) + '</label>' +
        '<select id="' + escapeHtml(id) + '">' +
        options.map(([optionValue, optionLabel]) =>
          '<option value="' + escapeHtml(optionValue) + '"' + (optionValue === value ? " selected" : "") + '>' +
          escapeHtml(optionLabel) + '</option>'
        ).join("") +
        '</select></div>';
    }

    function renderFilterBar() {
      const bar = document.getElementById("filterBar");
      const controls = [
        selectHtml("exchangeFilter", "交易所", state.exchangeFilter, exchangeOptions(state.items)),
        selectHtml("quotaFilter", "额度", state.quotaFilter, [
          ["all", "不限额度"],
          ["unlimited", "无限额"],
          ["capped", "有额度"],
          ["unknown", "额度待核验"]
        ]),
        selectHtml("lockFilter", "赎回期", state.lockFilter, [
          ["all", "不限赎回期"],
          ["flexible", "活期/无锁仓"],
          ["locked", "锁仓/赎回"],
          ["unknown", "锁仓待核验"]
        ]),
        selectHtml("sortMode", "排序", state.sortMode, [
          ["apy", "实时年利率"],
          ["deadline", "到期时间"]
        ])
      ];
      bar.innerHTML = controls.join("");
      for (const id of ["exchangeFilter", "quotaFilter", "lockFilter", "sortMode"]) {
        const element = document.getElementById(id);
        element.addEventListener("change", () => {
          state[id] = element.value;
          render();
        });
      }
    }

    function uniqueByKey(items) {
      const seen = new Set();
      return items.filter((item) => {
        const key = item.source_url || item.official_url || item.activity_name + "|" + (item.exchange || item.venue || "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function cardHtml(item, options = {}) {
      const source = item.source_url
        ? '<a href="' + escapeHtml(item.source_url) + '" target="_blank" rel="noreferrer">来源：' + escapeHtml(item.source_user || "X 帖") + '</a>'
        : '<span class="muted">来源：未提供</span>';
      const official = item.official_url
        ? '<a href="' + escapeHtml(item.official_url) + '" target="_blank" rel="noreferrer">官方入口</a>'
        : "";
      const venue = item.section === "cex" ? item.exchange : item.venue;
      const deadline = item.deadline_at
        ? fmtTime(item.deadline_at)
        : item.deadline_source === "no_fixed_deadline"
          ? "无固定截止"
          : "截止待确认";
      const risk = riskText(item);
      const riskShort = risk.length > 92 ? risk.slice(0, 92) + "..." : risk;
      const participation = participationText(item);
      const participationShort = participation.length > 120 ? participation.slice(0, 120) + "..." : participation;
      return '<article class="opportunity-card">' +
        '<div class="card-meta">' +
          '<span class="tag info">' + escapeHtml(typeLabel(item.type)) + '</span>' +
          '<span class="tag ' + reviewClass(item) + '">' + escapeHtml(reviewLabel(item)) + '</span>' +
          '<span class="tag ' + freshnessClass(item) + '">' + escapeHtml(item.freshness?.label || "时间待确认") + '</span>' +
        '</div>' +
        '<h3>' + escapeHtml(activityText(item)) + '</h3>' +
        '<div class="card-row">' +
          '<span class="tag">' + escapeHtml(venue || "未知平台") + '</span>' +
          '<span class="tag">' + escapeHtml(item.stablecoin || item.asset || "币种待确认") + '</span>' +
          '<span class="tag apy">' + escapeHtml(yieldText(item)) + '</span>' +
          '<span class="tag warn">' + escapeHtml(deadline) + '</span>' +
        '</div>' +
        '<p class="card-text"><span class="card-label">参与方式：</span>' + escapeHtml(participationShort) + '</p>' +
        '<p class="card-text"><span class="card-label">主要风险：</span>' + escapeHtml(riskShort) + '</p>' +
        '<div class="source-row">' + source + (official ? official : "") + '</div>' +
        (options.compact ? "" : '<div class="card-row"><span class="tag ' + qualityClass(item) + '">' + escapeHtml(qualityText(item)) + '</span><span class="tag ' + riskClass(item) + '">' + escapeHtml(riskLevelText(item)) + '</span></div>') +
        '</article>';
    }

    function renderSpotlight() {
      const container = document.getElementById("spotlight");
      const baseItems = defaultItems();
      if (!baseItems.length) {
        container.innerHTML = '<div class="empty">当前没有可直接展示的已核验机会；可切换到“待核验”查看候选。</div>';
        return;
      }
      const stable = baseItems
        .filter((item) => item.type === "stablecoin_earn")
        .sort((a, b) => Number(b.yield_profile?.max_apy ?? b.apy ?? 0) - Number(a.yield_profile?.max_apy ?? a.apy ?? 0));
      const urgent = baseItems.filter((item) => item.urgency?.level === "urgent" || item.urgency?.level === "soon");
      const preTge = baseItems.filter((item) => item.type === "pre_tge");
      const preIpo = baseItems.filter((item) => item.type === "pre_ipo");
      const onchain = baseItems.filter((item) => item.section === "onchain");
      const picks = uniqueByKey([
        stable[0],
        urgent[0],
        preTge[0],
        preIpo[0],
        onchain[0],
        ...baseItems
      ].filter(Boolean)).slice(0, 4);
      container.innerHTML = picks.map((item) => cardHtml(item, { compact: true })).join("");
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
        escapeHtml("只统计 APY > 10% 的 USDT/USDC/USD1 机会") + '</span></div>' +
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

    function renderSecurityIncidents() {
      const container = document.getElementById("securityIncidents");
      const security = state.securityIncidents;
      if (!security) {
        container.innerHTML = "";
        return;
      }
      const items = security.items || [];
      const health = security.latest_health || {};
      const skipReasons = security.skip_reasons || {};
      const skipText = Object.keys(skipReasons).length
        ? Object.entries(skipReasons).slice(0, 4).map(([key, value]) => key + ":" + value).join(" | ")
        : "无";
      const itemHtml = items.length
        ? items.slice(0, 5).map((item) => {
          const tone = item.alert_level === "critical" ? "risk" : item.alert_level === "anomaly" ? "warn" : "info";
          const amount = Number.isFinite(Number(item.amount_usd)) ? "$" + Math.round(Number(item.amount_usd)).toLocaleString("en-US") : "金额未知";
          const pushed = item.critical_pushed_at || item.anomaly_pushed_at ? "已推送" : "未推送";
          return '<div class="gap-item"><strong>' + escapeHtml(item.project || "未知项目") +
            ' <span class="tag ' + tone + '">' + escapeHtml(item.alert_level || "watch") + '</span></strong>' +
            '<span class="muted">' + escapeHtml(amount + " · " + (item.incident_type || "security") + " · " + pushed) + '</span>' +
            '<span class="muted">证据 ' + escapeHtml(String(item.evidence_score ?? "未知")) + ' · ' + escapeHtml(fmtTime(item.source_published_at)) + '</span>' +
            (item.source_url ? '<span class="muted"><a href="' + escapeHtml(item.source_url) + '" target="_blank" rel="noreferrer">来源链接</a></span>' : "") +
            '</div>';
        }).join("")
        : '<div class="gap-item"><strong>最近事件 <span class="tag info">暂无</span></strong><span class="muted">当前没有入库的安全事件。</span></div>';
      container.innerHTML =
        '<div class="coverage-title"><strong>安全事件监控</strong><span class="muted">最近状态：' +
        escapeHtml(health.status || "未知") + " · " + escapeHtml(fmtTime(health.ts)) + '</span></div>' +
        '<div class="gap-list">' +
        '<div class="gap-item"><strong>跳过原因 <span class="tag info">' + escapeHtml(skipText) + '</span></strong><span class="muted">' +
        escapeHtml(health.detail || "暂无运行详情") + '</span></div>' +
        itemHtml +
        '</div>';
    }

    function listRowHtml(item) {
      const source = item.source_url
        ? '<a href="' + escapeHtml(item.source_url) + '" target="_blank" rel="noreferrer">' + escapeHtml(item.source_user || "来源帖") + '</a>'
        : '<span class="muted">未提供来源</span>';
      const official = item.official_url
        ? ' · <a href="' + escapeHtml(item.official_url) + '" target="_blank" rel="noreferrer">官方入口</a>'
        : "";
      const venue = item.section === "onchain" ? item.venue : item.exchange;
      const asset = item.stablecoin || item.asset || "未注明";
      const campaign = item.campaign_profile || {};
      const duplicate = item.duplicate_profile || {};
      const duplicateTag = Number(duplicate.source_count || 0) > 1
        ? '<span class="tag hot">合并 ' + escapeHtml(String(duplicate.source_count)) + ' 来源</span>'
        : "";
      const duplicateSourceText = Number(duplicate.source_count || 0) > 1
        ? '<span class="muted">合并来源：' + escapeHtml((duplicate.source_users || []).join(" / ") || String(duplicate.source_count) + " 个来源") +
          (duplicate.apy_range_label ? " · " + escapeHtml(duplicate.apy_range_label) : "") + '</span>'
        : "";
      const deadline = item.deadline_at
        ? fmtTime(item.deadline_at)
        : item.deadline_source === "no_fixed_deadline"
          ? "无固定截止"
          : "截止待确认";
      const paramTags = [
        campaign.quota_label,
        campaign.payout_label,
        campaign.lock_label,
        campaign.time_left_label
      ].filter(Boolean).map((label) => '<span class="tag">' + escapeHtml(label) + '</span>').join("");
      return '<article class="opportunity-row">' +
        '<div class="row-title row-block"><div class="card-meta">' +
          '<span class="tag info">' + escapeHtml(displayCategoryLabels[item.display_category] || typeLabel(item.type)) + '</span>' +
          '<span class="tag apy">' + escapeHtml(campaign.event_type || typeLabel(item.type)) + '</span>' +
          duplicateTag +
          '<span class="tag ' + reviewClass(item) + '">' + escapeHtml(reviewLabel(item)) + '</span>' +
          '<span class="tag ' + freshnessClass(item) + '">' + escapeHtml(item.freshness?.label || "时间待确认") + '</span>' +
        '</div><h3>' + escapeHtml(activityText(item)) + '</h3>' +
        '<div class="card-row"><span class="tag">' + escapeHtml(campaign.platform_path || venue || "未知平台") + '</span>' +
        '<span class="tag">' + escapeHtml(item.section === "onchain" ? "链上/DEX" : "CEX") + '</span>' +
        '<span class="tag">' + escapeHtml(asset) + '</span></div></div>' +
        '<div class="row-block"><span class="row-label">实时年利率</span>' +
          '<span class="tag apy">' + escapeHtml(yieldText(item)) + '</span>' +
          yieldProfileHtml(item) +
          '<p class="card-text">' + escapeHtml(campaign.estimated_return_label || item.display_reason || localizeText(item.reward || item.expected_yield, "收益需核验")) + '</p></div>' +
        '<div class="row-block"><span class="row-label">参数 / 到期</span>' +
          '<div class="card-row">' + paramTags + '</div>' +
          '<p class="card-text">' + escapeHtml(localizeText(item.duration, "时间成本未注明")) + '</p>' +
          '<span class="tag warn">' + escapeHtml(deadline) + '</span></div>' +
        '<div class="row-block"><span class="row-label">参与与风险</span>' +
          '<p class="card-text">' + escapeHtml(participationText(item)) + '</p>' +
          '<p class="card-text"><span class="card-label">风险：</span>' + escapeHtml(riskText(item)) + '</p>' +
          '<div class="source-row">' + source + official + duplicateSourceText + '</div></div>' +
      '</article>';
    }

    function renderTable() {
      const content = document.getElementById("content");
      const items = filteredItems();
      if (items.length === 0) {
        content.className = "empty";
        content.textContent = "当前没有未过期或两个月内待复查的机会。";
        return;
      }
      content.className = "table-wrap";
      const sortLabel = state.sortMode === "deadline" ? "到期时间" : "实时年利率";
      const dedupeNote = state.displayFilter?.duplicate_item_count
        ? "；已合并 " + state.displayFilter.duplicate_item_count + " 条重复来源"
        : "";
      content.innerHTML =
        '<section class="section-head"><div><h2>活动列表</h2><p>共 ' + escapeHtml(String(items.length)) +
        ' 条。当前按' + escapeHtml(sortLabel) + '排序；新户专属已默认过滤，其余未到期活动持续展示' + escapeHtml(dedupeNote) + '。</p></div></section>' +
        '<div class="opportunity-list">' + items.map((item) => listRowHtml(item)).join("") + '</div>';
    }

    function renderStatus() {
      const run = state.latestRun || {};
      const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
      };
      setText("lastRun", fmtTime(run.finished_at || run.started_at));
      setText("nextRun", nextRunText(state.monitor, state.queryPlan));
      setText("runStatus", runStatusText(run, state.monitor, state.runHealth));
      setText("totalCount", String(state.items.length));
      setText("coverageQuality", coverageQualityText(state.coverage));
      setText("queryPlanSummary", queryPlanSummaryText(state.queryPlan));
      setText("stablecoinTop", stablecoinTopText(state.stablecoinSummary));
      setText("freshnessQuality", freshnessQualityText(state.items));
      setText("shortTermCount", String(state.items.filter((item) => item.display_category === "quick_opportunity").length));
      setText("deadlineQuality", deadlineQualityText(state.items));
      setText("officialQuality", officialQualityText(state.items));
      setText("dataQuality", dataQualityText(state.items));
      setText("fieldGapQuality", fieldGapQualityText(state.fieldGaps));
      setText("enrichmentBacklogMetric", enrichmentBacklogText(state.enrichmentBacklog));
      setText("diagnosticStatus", diagnosticStatusText(state.diagnostics));
      setText("securityIncidentMetric", securityIncidentSummaryText(state.securityIncidents));
      setText("jobStatsSummary", jobStatsSummaryText(run));
      setText("watchCount", watchCountText(state.items));
      setText("urgentCount", urgentCountText(state.items));
      setText("highRiskCount", highRiskCountText(state.items));
    }

    function render() {
      renderStatus();
      renderCoverage();
      renderQueryPlan();
      renderStablecoinSummary();
      renderRunHistory();
      renderJobStats();
      renderDiagnostics();
      renderSecurityIncidents();
      renderFieldGaps();
      renderEnrichmentBacklog();
      renderTabs();
      renderFilterBar();
      renderTable();
    }

    async function load() {
      const [opportunityResponse, securityResponse] = await Promise.all([
        fetch("/api/opportunities"),
        fetch("/api/security-incidents").catch(() => null)
      ]);
      const body = await opportunityResponse.json();
      const securityBody = securityResponse ? await securityResponse.json() : null;
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
      state.displayFilter = body.display_filter || null;
      state.securityIncidents = securityBody?.ok ? securityBody : null;
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
  getSecurityIncidentStatus,
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
      const displayPayload = getDisplayOpportunityPayload(db, config);
      const items = displayPayload.items;
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
        display_filter: displayPayload.summary,
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
      const items = getDisplayOpportunityPayload(db, config).items;
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

  app.get("/api/security-incidents", (_req, res) => {
    try {
      res.json(buildSecurityIncidentPayload(db, getSecurityIncidentStatus));
    } catch (error) {
      logger.warn("security_incidents_api_failed", { error: String(error.message || error) });
      res.status(500).json({ ok: false, error: "security_incidents_api_failed" });
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
