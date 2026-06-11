import { execFile } from "node:child_process";
import { logger } from "./logger.js";
import { buildCexCoverage } from "./opportunityAnalytics.js";
import { enrichOpportunities } from "./opportunityEnrichment.js";
import { normalizeOpportunityBatchWithReport, parseXintelOpportunities } from "./opportunityUtils.js";

const OUTPUT_SCHEMA =
  '{"generated_at":"ISO","opportunities":[{"activity_name":"","type":"launch|pre_ipo|short_term|stablecoin_earn|onchain","section":"cex|onchain","exchange":"Binance|OKX|Bybit|Gate|Bitget|","venue":"","asset":"","stablecoin":"USDT|USDC|USD1|","apy":null,"expected_yield":"","reward":"","duration":"","deadline_at":null,"deadline_text":"","deadline_source":"x_post|official_page|grok|no_fixed_deadline|unverified","deadline_confidence":0,"official_url":"https://...","source_published_at":null,"participation":"","source_user":"@","source_url":"https://x.com/.../status/...","credibility":"official|kol|unverified","risk_note":""}]}';

const FIELD_RULES = `
字段硬要求：
- source_url 必须是可追踪的 X 帖子链接，优先 x.com/.../status/...；source_user 必须是发帖账号。
- source_published_at 必须填 X 帖发布时间的 UTC ISO；如果 Grok 无法确认，留 null 并把 credibility="unverified"。
- official_url 必须优先官方公告页或具体活动页；没有官方页时留空，不要填交易所首页、Earn 首页或泛产品首页。
- deadline_at 能确认必须填 UTC ISO；deadline_text 保留原始截止/活动期文本；deadline_source 标 official_page/x_post/grok。
- 官方说明“长期/持续中/无固定截止”时 deadline_source="no_fixed_deadline"，deadline_at=null。
- 不能确认固定截止时间时 deadline_source="unverified"，不要把“截止未知”当成 duration 或 deadline_text 的有效证据。
- 稳定币理财的 apy 只填普通用户可入库/可持续认购的 APY；如果有新户、限额、限时促销最高 APY，写进 expected_yield/reward/duration，并说明新户/限额/地区/期限条件，不要只返回最高宣传值。
- participation 写成中文步骤，至少说明入口、资产、认购/交易/锁仓动作；有官方入口时写清入口名称。
- risk_note 用中文，必须提示地区限制、额度、锁仓/赎回、交易/合约、链上合约或对手方风险。
`.trim();

const QUERY_JOB_LABELS = {
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

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function buildSearchPrompt(config) {
  const lookbackHours = clampInt(config.opportunityLookbackHours, 24, 72, 72);
  return `
用 X/Grok 搜索过去 ${lookbackHours} 小时的高收益机会，最多返回 12 条。必须覆盖：
- CEX 只限 Binance/OKX/Bybit/Gate/Bitget：打新、Launchpad/IEO/IDO/Farm/任务、Pre-IPO/Pre-token/Pre-listing、短期高收益活动、稳定币理财。
- 必查 Gate/Gate.io 是否有 SpaceX、SPCX、xStocks、IPO/Pre-IPO/Pre-market 相关机会。
- 链上/DEX 单独 section=onchain。
- 稳定币理财只收 USDT/USDC/USD1 且 APY>=8。
- CEX 部分忽略非上述 5 家交易所；全局忽略过期、纯广告、无来源内容。
优先官方账号或高互动可靠 KOL。只输出 JSON，不要解释：
${OUTPUT_SCHEMA}
${FIELD_RULES}
除专有名词、交易所名、币种、URL 外，activity_name/expected_yield/reward/duration/participation/risk_note 必须使用简体中文。
`.trim();
}

function buildGateSpaceXPrompt(config) {
  const lookbackHours = clampInt(config.opportunityLookbackHours, 24, 72, 72);
  return `
用 X/Grok 专门搜索过去 ${lookbackHours} 小时 Gate/Gate.io 的 SpaceX/SPCX/xStocks/Pre-IPO/Pre-market/Startup/Launchpad 机会。只收 Gate/Gate.io 或高互动可靠来源。最多返回 6 条，过期或无来源则不要返回。
只输出 JSON：
${OUTPUT_SCHEMA}
${FIELD_RULES}
除专有名词、币种、URL 外，activity_name/expected_yield/reward/duration/participation/risk_note 必须使用简体中文。
`.trim();
}

function buildCexPreIpoPrompt(config) {
  const lookbackHours = clampInt(config.opportunityLookbackHours, 24, 72, 72);
  return `
用 X/Grok 做 CEX × Pre-IPO/Pre-token/Pre-listing 专题搜索，范围是过去 ${lookbackHours} 小时。必须分别覆盖 Binance、OKX、Bybit、Gate、Bitget，每家最多 2 条。
关键词矩阵：
- Binance: Pre-IPO Perps, stocks perps, SpaceX, OpenAI, tokenized stock, pre-market
- OKX: pre-market, pre-token, pre-listing, Jumpstart, xStocks, SpaceX
- Bybit: IPO Express, Pre-IPO, tokenized shares, SpaceX
- Gate/Gate.io: IPO Access, Startup, SpaceX IPO, SPCX, xStocks
- Bitget: Pre-market, Pre-IPO, SPCX, LaunchX, Launchpool
只收官方账号或高互动可靠 KOL；过期、无来源、纯广告不要返回。稳定币参与方式必须标出 USDT/USDC/USD1。
只输出 JSON，不要解释：
${OUTPUT_SCHEMA}
${FIELD_RULES}
除专有名词、交易所名、币种、URL 外，activity_name/expected_yield/reward/duration/participation/risk_note 必须使用简体中文。
`.trim();
}

function buildCexLaunchPrompt(config) {
  const lookbackHours = clampInt(config.opportunityLookbackHours, 24, 72, 72);
  return `
用 X/Grok 做 CEX × 打新专题搜索，范围是过去 ${lookbackHours} 小时。只限 Binance、OKX、Bybit、Gate、Bitget 官方 Launchpad/Launchpool/Startup/IEO/IDO/Farm/任务活动，每家最多 2 条。
关键词矩阵：
- Binance: Launchpool, Megadrop, HODLer Airdrops, Wallet campaign, Alpha airdrop
- OKX: Jumpstart, Cryptopedia, Giveaway, new listing campaign
- Bybit: Launchpool, Launchpad, ByStarter, airdrop, Puzzle Hunt
- Gate/Gate.io: Startup, Launchpad, CandyDrop, HODL & Earn
- Bitget: Launchpool, PoolX, CandyBomb, LaunchX, Launchpad
只收未过期、来源可追踪的机会；奖励方式、截止时间和参与步骤要写清楚。
只输出 JSON，不要解释：
${OUTPUT_SCHEMA}
${FIELD_RULES}
除专有名词、交易所名、币种、URL 外，activity_name/expected_yield/reward/duration/participation/risk_note 必须使用简体中文。
`.trim();
}

function buildCexStablecoinPrompt(config) {
  const lookbackHours = clampInt(config.opportunityLookbackHours, 24, 72, 72);
  return `
用 X/Grok 做 CEX × 稳定币理财专题搜索，范围是过去 ${lookbackHours} 小时。只限 Binance、OKX、Bybit、Gate、Bitget；只收 USDT/USDC/USD1 且 APY/APR >= 8%，每家最多 3 条。
关键词矩阵：Earn, Simple Earn, Fixed Earn, Dual Investment, Launchpool, Shark Fin, Wealth, USDT APR, USDC APR, USD1 APR, limited-time APR, boosted APR。
必须写明普通用户可入库 APY、促销最高 APY、锁仓/灵活期限、可核验截止时间或 no_fixed_deadline、参与入口来源；APY 不明确或低于 8% 不要返回。
只输出 JSON，不要解释：
${OUTPUT_SCHEMA}
${FIELD_RULES}
除专有名词、交易所名、币种、URL 外，activity_name/expected_yield/reward/duration/participation/risk_note 必须使用简体中文。
`.trim();
}

function buildCexShortTermPrompt(config) {
  const lookbackHours = clampInt(config.opportunityLookbackHours, 24, 72, 72);
  return `
用 X/Grok 做 CEX × 短期高收益临时活动专题搜索，范围是过去 ${lookbackHours} 小时。只限 Binance、OKX、Bybit、Gate、Bitget，每家最多 2 条。
关键词矩阵：trading competition, leaderboard, fee rebate, points boost, double rewards, limited-time campaign, task, wallet campaign, prediction, airdrop task。
必须优先官方或高互动可靠 KOL；写清活动奖池、持续时间、参与步骤、是否需要交易/锁仓。
只输出 JSON，不要解释：
${OUTPUT_SCHEMA}
${FIELD_RULES}
除专有名词、交易所名、币种、URL 外，activity_name/expected_yield/reward/duration/participation/risk_note 必须使用简体中文。
`.trim();
}

function buildOnchainStablecoinPrompt(config) {
  const lookbackHours = clampInt(config.opportunityLookbackHours, 24, 72, 72);
  return `
用 X/Grok 做链上/DEX 稳定币收益专题搜索，范围是过去 ${lookbackHours} 小时。只收 USDT/USDC/USD1，APY/APR >= 8%，最多返回 10 条。
关键词矩阵：USDC APY, USDT APY, vault, Pendle PT/LP, Morpho, Aave, Spark, Kamino, Ethena, RWA vault, credit market, Base, Ethereum, Solana, Arbitrum。
必须 section=onchain，exchange=""；写明协议/链、APY、期限、参与步骤、来源帖。忽略无来源、明显广告、已过期、疑似骗局。
只输出 JSON：
${OUTPUT_SCHEMA}
${FIELD_RULES}
除专有名词、币种、URL 外，activity_name/expected_yield/reward/duration/participation/risk_note 必须使用简体中文。
`.trim();
}

function buildOnchainPointsPrompt(config) {
  const lookbackHours = clampInt(config.opportunityLookbackHours, 24, 72, 72);
  return `
用 X/Grok 做链上/DEX 积分、空投、LP/Farm 激励专题搜索，范围是过去 ${lookbackHours} 小时，最多返回 10 条。
关键词矩阵：points, airdrop, multiplier, double points, LP incentives, farm, boost, DEX campaign, testnet task, RWA points, Base, Solana, Ethereum, Arbitrum。
必须 section=onchain，exchange=""；写清协议/链、奖励方式、持续时间、参与步骤、来源帖。忽略无来源、明显广告、已过期、疑似骗局。
只输出 JSON：
${OUTPUT_SCHEMA}
${FIELD_RULES}
除专有名词、币种、URL 外，activity_name/expected_yield/reward/duration/participation/risk_note 必须使用简体中文。
`.trim();
}

function buildCoverageGapPrompt(config, gaps) {
  const lookbackHours = clampInt(config.opportunityLookbackHours, 24, 72, 72);
  const gapLines = gaps
    .slice(0, 6)
    .map((gap, index) => `${index + 1}. ${gap.exchange} / ${gap.label}: ${gap.suggested_query}`)
    .join("\n");
  return `
用 X/Grok 针对当前网页覆盖矩阵的空白缺口做补查，范围是过去 ${lookbackHours} 小时。优先补查以下缺口：
${gapLines}

规则：
- 只限 Binance、OKX、Bybit、Gate、Bitget；不要返回其他 CEX。
- 稳定币理财只收 USDT/USDC/USD1 且 APY/APR >= 8%。
- Pre-IPO/Pre-token/Pre-listing 必须写清是否可用稳定币参与。
- 如果补查后仍找不到可靠、未过期、来源可追踪的机会，对该缺口不要编造条目。
- 只收官方账号或高互动可靠 KOL；每个缺口最多返回 2 条。
只输出 JSON，不要解释：
${OUTPUT_SCHEMA}
${FIELD_RULES}
除专有名词、交易所名、币种、URL 外，activity_name/expected_yield/reward/duration/participation/risk_note 必须使用简体中文。
`.trim();
}

function buildCoverageGapJob(config, currentItems = []) {
  if (!config.opportunityQueryMatrixEnabled || !Array.isArray(currentItems) || currentItems.length === 0) return null;
  const coverage = buildCexCoverage(currentItems);
  const gaps = coverage.gaps.filter((gap) => gap.priority === "high" || gap.priority === "medium");
  if (!gaps.length) return null;
  return { name: "cex_coverage_gaps", prompt: buildCoverageGapPrompt(config, gaps), gaps: gaps.slice(0, 6) };
}

function latestJobTimedOut(latestRun, jobName) {
  const stats = Array.isArray(latestRun?.job_stats) ? latestRun.job_stats : [];
  if (stats.some((job) => job.name === jobName && /hermes_timeout_after_\d+ms/i.test(String(job.error || "")))) {
    return true;
  }
  return String(latestRun?.error || "").split(";").some((part) => {
    const text = part.trim();
    return text.startsWith(`${jobName}:`) && /hermes_timeout_after_\d+ms/i.test(text);
  });
}

function buildQueryAdaptations(config, latestRun) {
  const adaptations = [];
  const skipMain =
    Boolean(config.opportunityAdaptiveQueryPlanEnabled) &&
    Boolean(config.opportunityQueryMatrixEnabled) &&
    latestJobTimedOut(latestRun, "main");

  if (skipMain) {
    adaptations.push({
      key: "skip_main_after_timeout",
      label: "主查询超时降级",
      reason: "最近一轮主查询超时，本轮把任务名额让给更小的专题查询和覆盖缺口补查。",
      affected_job: "main"
    });
  }

  return { skipMain, adaptations };
}

function rotateJobs(jobs, limit, offset) {
  if (limit <= 0 || jobs.length === 0) return [];
  if (limit >= jobs.length) return jobs;
  const start = Math.abs(Number(offset || 0)) % jobs.length;
  return Array.from({ length: limit }, (_, index) => jobs[(start + index) % jobs.length]);
}

function buildSearchPrompts(config, rotationOffset = 0, currentItems = [], queryContext = {}) {
  const maxJobs = clampInt(
    config.opportunityMaxQueryJobs,
    1,
    20,
    config.opportunityQueryMatrixEnabled ? 5 : 3
  );
  const prompts = queryContext.skipMain ? [] : [{ name: "main", prompt: buildSearchPrompt(config) }];

  if (config.opportunityFocusedQueriesEnabled && prompts.length < maxJobs) {
    prompts.push({ name: "gate_spacex", prompt: buildGateSpaceXPrompt(config) });
  }

  const coverageGapJob = buildCoverageGapJob(config, currentItems);
  if (coverageGapJob && prompts.length < maxJobs) {
    prompts.push(coverageGapJob);
  }

  const matrixJobs = config.opportunityQueryMatrixEnabled
    ? [
        { name: "cex_pre_ipo", prompt: buildCexPreIpoPrompt(config) },
        { name: "cex_launch", prompt: buildCexLaunchPrompt(config) },
        { name: "cex_stablecoin_earn", prompt: buildCexStablecoinPrompt(config) },
        { name: "cex_short_term", prompt: buildCexShortTermPrompt(config) },
        { name: "onchain_stablecoin", prompt: buildOnchainStablecoinPrompt(config) },
        { name: "onchain_points_lp", prompt: buildOnchainPointsPrompt(config) }
      ]
    : config.opportunityFocusedQueriesEnabled
      ? [{ name: "onchain", prompt: buildOnchainStablecoinPrompt(config) }]
      : [];

  const remaining = maxJobs - prompts.length;
  if (remaining > 0) {
    prompts.push(...rotateJobs(matrixJobs, remaining, rotationOffset));
  }
  return prompts;
}

function getCurrentOpportunityRows(db, config) {
  try {
    return (
      db.getDisplayOpportunities?.(config.opportunityStaleAfterHours) ||
      db.getActiveOpportunities?.(config.opportunityStaleAfterHours) ||
      []
    );
  } catch (error) {
    logger.warn("opportunity_coverage_rows_failed", { error: String(error.message || error) });
    return [];
  }
}

function summarizeQueryJobs(jobs = []) {
  return jobs.map((job) => ({
    name: job.name,
    label: QUERY_JOB_LABELS[job.name] || job.name,
    type: job.name === "cex_coverage_gaps" ? "coverage_gap" : job.name.startsWith("onchain") ? "onchain" : "cex",
    gaps: Array.isArray(job.gaps)
      ? job.gaps.map((gap) => ({
          exchange: gap.exchange,
          label: gap.label,
          priority: gap.priority,
          suggested_query: gap.suggested_query
        }))
      : []
  }));
}

function countByXintelJob(items = []) {
  const counts = new Map();
  for (const item of items) {
    let job = "";
    try {
      job = JSON.parse(item.raw_json || "{}").__xintel_job || "";
    } catch {
      job = "";
    }
    if (!job) continue;
    counts.set(job, (counts.get(job) || 0) + 1);
  }
  return counts;
}

function applyJobItemCounts(jobStats, { normalizedItems = [], savedItems = [], normalizeReport = {} }) {
  const normalizedCounts = countByXintelJob(normalizedItems);
  const savedCounts = countByXintelJob(savedItems);
  return jobStats.map((stat) => ({
    ...stat,
    normalized_count: normalizedCounts.get(stat.name) || 0,
    saved_count: savedCounts.get(stat.name) || 0,
    drop_count: normalizeReport.by_job?.[stat.name]?.dropped_count || 0,
    duplicate_count: normalizeReport.by_job?.[stat.name]?.duplicate_count || 0,
    drop_reasons: normalizeReport.by_job?.[stat.name]?.drop_reasons || []
  }));
}

function buildFollowupPrompt(item) {
  return `
请只针对下面这个候选机会补查 X 原帖，补齐缺失字段。若无法确认，请返回原字段并把 credibility 设为 "unverified"。

候选：
${JSON.stringify(item, null, 2)}

只输出同一个 JSON 对象，不要输出解释文字。
`.trim();
}

function needsFollowup(item) {
  if (!item) return false;
  if (!item.source_url || !item.source_user) return true;
  if (item.type === "stablecoin_earn" && (!Number.isFinite(item.apy) || !item.deadline_at)) return true;
  if ((item.type === "launch" || item.type === "pre_ipo") && !item.deadline_at) return true;
  return false;
}

export class OpportunityMonitor {
  constructor({ config, db }) {
    this.config = config;
    this.db = db;
    this.isRunning = false;
    this.timer = null;
    this.nextRunAt = null;
    this.lastStartedAt = null;
    this.lastFinishedAt = null;
    this.lastError = "";
  }

  getStatus() {
    return {
      enabled: Boolean(this.config.opportunityMonitorEnabled),
      running: this.isRunning,
      last_started_at: this.lastStartedAt,
      last_finished_at: this.lastFinishedAt,
      next_run_at: this.nextRunAt,
      last_error: this.lastError
    };
  }

  getQueryPlan() {
    const latestRun = this.db.getLatestOpportunityRun?.() || null;
    const rotationOffset = Number(latestRun?.id || 0);
    const currentItems = getCurrentOpportunityRows(this.db, this.config);
    const queryContext = buildQueryAdaptations(this.config, latestRun);
    const jobs = buildSearchPrompts(this.config, rotationOffset, currentItems, queryContext);
    return {
      enabled: Boolean(this.config.opportunityMonitorEnabled),
      running: this.isRunning,
      interval_sec: Number(this.config.opportunityIntervalSec || 0),
      lookback_hours: Number(this.config.opportunityLookbackHours || 72),
      max_jobs: clampInt(this.config.opportunityMaxQueryJobs, 1, 20, this.config.opportunityQueryMatrixEnabled ? 5 : 3),
      job_count: jobs.length,
      adaptive: Boolean(this.config.opportunityAdaptiveQueryPlanEnabled),
      adaptations: queryContext.adaptations,
      jobs: summarizeQueryJobs(jobs)
    };
  }

  async callHermes(prompt) {
    const timeoutMs = clampInt(this.config.opportunityHermesTimeoutSec, 10, 600, 120) * 1000;
    return new Promise((resolve, reject) => {
      execFile(
        this.config.opportunityHermesBin || "hermes",
        ["--profile", this.config.opportunityHermesProfile || "xintel", "-z", prompt],
        {
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          const output = String(stdout || "").trim();
          const errorOutput = String(stderr || "").trim();
          if (error) {
            const isTimeout = error.killed || error.signal === "SIGTERM";
            const detail = isTimeout
              ? `hermes_timeout_after_${timeoutMs}ms`
              : `hermes_failed:${error.code || error.signal || "unknown"}`;
            const wrapped = new Error(detail);
            wrapped.stdout = output;
            wrapped.stderr = errorOutput;
            reject(wrapped);
            return;
          }
          resolve(output || errorOutput);
        }
      );
    });
  }

  async hydrateCandidates(items) {
    const maxFollowups = clampInt(this.config.opportunityMaxFollowups, 0, 10, 3);
    if (maxFollowups <= 0) return items;

    const hydrated = [...items];
    let used = 0;
    for (let i = 0; i < hydrated.length && used < maxFollowups; i += 1) {
      if (!needsFollowup(hydrated[i])) continue;
      used += 1;
      try {
        const raw = await this.callHermes(buildFollowupPrompt(hydrated[i]));
        const parsed = parseXintelOpportunities(raw);
        const replacement = parsed.ok && parsed.opportunities.length > 0 ? parsed.opportunities[0] : null;
        if (replacement && typeof replacement === "object") {
          hydrated[i] = { ...hydrated[i], ...replacement };
        }
      } catch (error) {
        logger.warn("opportunity_followup_failed", { error: String(error.message || error) });
      }
    }
    return hydrated;
  }

  async enrichExistingOpportunities(seenDedupKeys = new Set()) {
    const limit = clampInt(this.config.opportunityExistingEnrichmentMaxItems, 0, 20, 2);
    if (!this.config.opportunityEnrichmentEnabled || limit <= 0) return 0;
    const candidates = this.db
      .getOpportunityDeadlineEnrichmentCandidates?.(
        limit + seenDedupKeys.size + 5,
        clampInt(this.config.opportunityEnrichmentRetryCooldownHours, 0, 168, 12)
      )
      ?.filter((item) => !seenDedupKeys.has(item.dedup_key))
      .slice(0, limit);
    if (!candidates?.length) return 0;

    const enriched = await enrichOpportunities(candidates, {
      config: {
        ...this.config,
        opportunityEnrichmentMaxItems: limit,
        opportunityGrokDeadlineFallbackMax: Math.min(
          clampInt(this.config.opportunityGrokDeadlineFallbackMax, 0, 10, 2),
          1
        )
      },
      callHermes: this.callHermes.bind(this)
    });
    for (const item of enriched) {
      this.db.upsertOpportunity?.(item);
    }
    return enriched.length;
  }

  async runOnce(trigger = "timer") {
    if (!this.config.opportunityMonitorEnabled) return { skipped: true, reason: "disabled" };
    if (this.isRunning) return { skipped: true, reason: "already_running" };

    this.isRunning = true;
    this.lastStartedAt = new Date().toISOString();
    this.lastError = "";
    const latestRun = this.db.getLatestOpportunityRun?.() || null;
    const rotationOffset = Number(latestRun?.id || 0);
    const currentItems = getCurrentOpportunityRows(this.db, this.config);
    const queryContext = buildQueryAdaptations(this.config, latestRun);
    const promptJobs = buildSearchPrompts(this.config, rotationOffset, currentItems, queryContext);
    const prompt = promptJobs.map((job) => `## ${job.name}\n${job.prompt}`).join("\n\n");
    const startedMs = Date.now();
    const runId = this.db.startOpportunityRun?.({ startedAt: this.lastStartedAt, prompt });
    let raw = "";
    let jobStats = [];

    try {
      const candidates = [];
      const errors = [];
      const rawParts = [];

      for (const job of promptJobs) {
        const jobStartedAt = new Date().toISOString();
        const jobStartedMs = Date.now();
        const jobInfo = summarizeQueryJobs([job])[0] || { name: job.name, label: job.name, type: "cex", gaps: [] };
        try {
          const jobRaw = await this.callHermes(job.prompt);
          rawParts.push(`## ${job.name}\n${jobRaw}`);
          const parsed = parseXintelOpportunities(jobRaw);
          if (!parsed.ok) {
            errors.push(`${job.name}:xintel_parse_failed:${parsed.error}`);
            jobStats.push({
              ...jobInfo,
              started_at: jobStartedAt,
              status: "parse_failed",
              duration_ms: Date.now() - jobStartedMs,
              raw_length: jobRaw.length,
              candidate_count: 0,
              normalized_count: 0,
              saved_count: 0,
              error: `xintel_parse_failed:${parsed.error}`
            });
            continue;
          }
          candidates.push(
            ...parsed.opportunities.map((item) =>
              item && typeof item === "object" ? { ...item, __xintel_job: job.name } : item
            )
          );
          jobStats.push({
            ...jobInfo,
            started_at: jobStartedAt,
            status: "ok",
            duration_ms: Date.now() - jobStartedMs,
            raw_length: jobRaw.length,
            candidate_count: parsed.opportunities.length,
            normalized_count: 0,
            saved_count: 0,
            error: ""
          });
        } catch (error) {
          const partialRaw = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
          if (partialRaw) rawParts.push(`## ${job.name}\n${partialRaw}`);
          const detail = String(error.message || error);
          errors.push(`${job.name}:${detail}`);
          jobStats.push({
            ...jobInfo,
            started_at: jobStartedAt,
            status: "error",
            duration_ms: Date.now() - jobStartedMs,
            raw_length: partialRaw.length,
            candidate_count: 0,
            normalized_count: 0,
            saved_count: 0,
            error: detail
          });
        }
      }

      raw = rawParts.join("\n\n");
      if (candidates.length === 0) {
        throw new Error(errors.length ? errors.join("; ") : "xintel_no_candidates");
      }

      const hydrated = await this.hydrateCandidates(candidates);
      const { items: normalizedItems, report: normalizeReport } = normalizeOpportunityBatchWithReport(hydrated, new Date(), {
        lookbackHours: this.config.opportunityLookbackHours
      });
      const items = await enrichOpportunities(normalizedItems, {
        config: this.config,
        callHermes: this.callHermes.bind(this)
      });
      jobStats = applyJobItemCounts(jobStats, { normalizedItems, savedItems: items, normalizeReport });
      for (const item of items) {
        this.db.upsertOpportunity?.(item);
      }
      const existingEnriched = await this.enrichExistingOpportunities(new Set(items.map((item) => item.dedup_key)));
      this.db.markExpiredOpportunities?.(new Date().toISOString());

      const durationMs = Date.now() - startedMs;
      this.db.finishOpportunityRun?.(runId, {
        status: errors.length ? "partial" : "ok",
        durationMs,
        rawResponse: raw,
        error: errors.join("; "),
        itemCount: items.length,
        jobStats
      });
      this.lastFinishedAt = new Date().toISOString();
      logger.info("opportunity_monitor_done", {
        trigger,
        items: items.length,
        existing_enriched: existingEnriched,
        duration_ms: durationMs,
        errors
      });
      return { ok: errors.length === 0, partial: errors.length > 0, items: items.length, existing_enriched: existingEnriched, errors };
    } catch (error) {
      const detail = String(error.message || error);
      const durationMs = Date.now() - startedMs;
      if (!raw && (error.stdout || error.stderr)) {
        raw = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      }
      this.lastError = detail;
      this.db.finishOpportunityRun?.(runId, {
        status: "error",
        durationMs,
        rawResponse: raw,
        error: detail,
        itemCount: 0,
        jobStats
      });
      this.db.recordHealth?.("opportunity_monitor", "error", detail);
      logger.warn("opportunity_monitor_failed", { trigger, error: detail });
      return { ok: false, error: detail };
    } finally {
      this.lastFinishedAt = new Date().toISOString();
      this.isRunning = false;
    }
  }

  start() {
    if (!this.config.opportunityMonitorEnabled || this.timer) return;
    const intervalSec = clampInt(this.config.opportunityIntervalSec, 60, 86400, 900);
    this.nextRunAt = new Date(Date.now() + intervalSec * 1000).toISOString();
    this.runOnce("startup").catch((error) => {
      logger.warn("opportunity_monitor_startup_failed", { error: String(error.message || error) });
    });
    this.timer = setInterval(() => {
      this.nextRunAt = new Date(Date.now() + intervalSec * 1000).toISOString();
      this.runOnce("timer").catch((error) => {
        logger.warn("opportunity_monitor_timer_failed", { error: String(error.message || error) });
      });
    }, intervalSec * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }
}
