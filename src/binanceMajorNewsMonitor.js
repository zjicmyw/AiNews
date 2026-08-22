import { logger } from "./logger.js";

const CATEGORY_MAX_SCORE = {
  tokenomics: 10,
  funding: 9,
  product: 8,
  partnership: 8,
  security: 9,
  team: 7
};

const EVENT_NOVELTIES = new Set([
  "new_decision", "first_disclosure", "new_launch", "material_change", "milestone", "ongoing_program", "recap"
]);
const MATERIALITIES = new Set(["transformative", "high", "moderate", "incremental"]);
const EVIDENCE_STRENGTHS = new Set(["confirmed", "credible_teaser", "vague"]);
const CATALYST_TYPES = new Set([
  "token_supply", "token_demand", "revenue_value_capture", "capital_inflow", "market_access",
  "distribution_adoption", "material_risk", "strategic_new_business", "none"
]);
const CATALYST_STRENGTHS = new Set(["high", "moderate", "low", "none"]);
const TOKEN_IMPACTS = new Set(["direct", "credible", "indirect", "none"]);
const PRODUCT_CHANGE_TYPES = new Set([
  "new_business", "new_consumer_product", "protocol_upgrade", "hard_fork", "testnet_devnet",
  "beta_waitlist", "performance_scaling", "developer_tooling", "ui_feature", "not_applicable"
]);
const ROUTINE_PRODUCT_CHANGES = new Set([
  "protocol_upgrade", "hard_fork", "testnet_devnet", "beta_waitlist", "performance_scaling", "developer_tooling", "ui_feature"
]);
const DIRECT_CATALYST_TYPES = new Set([
  "token_supply", "token_demand", "revenue_value_capture", "capital_inflow", "market_access", "distribution_adoption", "material_risk"
]);

const NON_PROJECT_ASSETS = new Set([
  "USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "USDE", "USDS", "USD1", "XUSD", "RLUSD",
  "AEUR", "EURI", "EUR", "TRY", "BRL", "JPY", "GBP", "AUD", "RUB", "UAH", "BIDR", "IDRT", "NGN",
  "BUSD", "UST", "USTC", "PAX", "VAI", "WBTC", "WBETH", "WETH", "BETH", "BNSOL"
]);

function extractJson(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new Error("invalid_json_response");
  }
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function isOfficialXStatusUrl(value) {
  return /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+/i.test(String(value || ""));
}

function normalizeItem(item, allowedSymbols, nowMs) {
  const symbol = String(item?.symbol || "").trim().toUpperCase();
  const category = String(item?.category || "").trim().toLowerCase();
  const score = Number(item?.score);
  const publishedMs = Date.parse(item?.published_at || "");
  const categoryMax = CATEGORY_MAX_SCORE[category];
  const eventNovelty = String(item?.event_novelty || "").trim().toLowerCase();
  const materiality = String(item?.materiality || "").trim().toLowerCase();
  const evidenceStrength = String(item?.evidence_strength || "").trim().toLowerCase();
  const catalystType = String(item?.catalyst_type || "").trim().toLowerCase();
  const catalystStrength = String(item?.catalyst_strength || "").trim().toLowerCase();
  const tokenImpact = String(item?.token_impact || "").trim().toLowerCase();
  const productChangeType = String(item?.product_change_type || "").trim().toLowerCase();
  const catalystPath = String(item?.catalyst_path_zh || "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (!allowedSymbols.has(symbol) || !categoryMax || !Number.isFinite(score)) return null;
  if (!EVENT_NOVELTIES.has(eventNovelty) || !MATERIALITIES.has(materiality) || !EVIDENCE_STRENGTHS.has(evidenceStrength)) return null;
  if (!CATALYST_TYPES.has(catalystType) || !CATALYST_STRENGTHS.has(catalystStrength) || !TOKEN_IMPACTS.has(tokenImpact)) return null;
  if (!PRODUCT_CHANGE_TYPES.has(productChangeType) || catalystPath.length < 8) return null;

  let scoreCap = categoryMax;
  if (["ongoing_program", "recap"].includes(eventNovelty)) scoreCap = Math.min(scoreCap, 4);
  if (materiality === "incremental") scoreCap = Math.min(scoreCap, 5);
  if (materiality === "moderate") scoreCap = Math.min(scoreCap, 6);
  if (evidenceStrength === "vague") scoreCap = Math.min(scoreCap, 5);
  if (evidenceStrength === "credible_teaser") scoreCap = Math.min(scoreCap, 8);
  if (["low", "none"].includes(catalystStrength) || catalystType === "none" || tokenImpact === "none") {
    scoreCap = Math.min(scoreCap, 5);
  }
  if (catalystStrength === "moderate") scoreCap = Math.min(scoreCap, 6);
  if (tokenImpact === "indirect") scoreCap = Math.min(scoreCap, 5);

  const hasDirectCatalyst = DIRECT_CATALYST_TYPES.has(catalystType)
    && catalystStrength === "high"
    && ["direct", "credible"].includes(tokenImpact);
  const isStrategicFirstDisclosure = catalystType === "strategic_new_business"
    && eventNovelty === "first_disclosure"
    && materiality === "high"
    && catalystStrength === "high"
    && tokenImpact === "credible"
    && evidenceStrength === "credible_teaser";
  if (category === "product" && ROUTINE_PRODUCT_CHANGES.has(productChangeType) && !hasDirectCatalyst) {
    scoreCap = Math.min(scoreCap, 5);
  }
  if (category === "product" && !hasDirectCatalyst && !isStrategicFirstDisclosure) {
    scoreCap = Math.min(scoreCap, 5);
  }

  const adjustedScore = Math.min(score, scoreCap);
  if (adjustedScore < 6) return null;
  if (!Number.isFinite(publishedMs) || publishedMs > nowMs + 10 * 60 * 1000) return null;
  if (nowMs - publishedMs > 5 * 24 * 60 * 60 * 1000) return null;
  if (!isOfficialXStatusUrl(item?.source_url)) return null;
  const sourceAccount = String(item?.source_account || "").trim();
  if (!/^@[A-Za-z0-9_]{1,15}$/.test(sourceAccount)) return null;
  return {
    token_name: String(item?.token_name || symbol).trim().slice(0, 80),
    symbol,
    score: adjustedScore,
    category,
    event_novelty: eventNovelty,
    materiality,
    evidence_strength: evidenceStrength,
    catalyst_type: catalystType,
    catalyst_strength: catalystStrength,
    token_impact: tokenImpact,
    product_change_type: productChangeType,
    catalyst_path_zh: catalystPath,
    score_reason_zh: String(item?.score_reason_zh || "").replace(/\s+/g, " ").trim().slice(0, 180),
    event_key: String(item?.event_key || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 100),
    announcement_phase: ["teaser", "announced", "launched"].includes(String(item?.announcement_phase || "").toLowerCase())
      ? String(item.announcement_phase).toLowerCase()
      : "announced",
    summary_zh: String(item?.summary_zh || "").replace(/\s+/g, " ").trim().slice(0, 260),
    published_at: new Date(publishedMs).toISOString(),
    source_account: sourceAccount,
    source_role: String(item?.source_role || "project_official").trim().slice(0, 30),
    source_url: String(item.source_url).trim()
  };
}

export class BinanceMajorNewsMonitor {
  constructor({ config, hermesClient, fetchFn = fetch }) {
    this.config = config;
    this.hermesClient = hermesClient;
    this.fetchFn = fetchFn;
  }

  async getUniverse() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(5, this.config.binanceMajorNewsTimeoutSec || 20) * 1000);
    try {
      const response = await this.fetchFn(`${this.config.binanceBaseUrl}/api/v3/exchangeInfo?permissions=SPOT`, {
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`binance_exchange_info_http_${response.status}`);
      const payload = await response.json();
      const assets = new Set();
      for (const market of payload?.symbols || []) {
        if (market?.status !== "TRADING" || market?.isSpotTradingAllowed === false) continue;
        const base = String(market?.baseAsset || "").trim().toUpperCase();
        if (!base || NON_PROJECT_ASSETS.has(base) || /(?:UP|DOWN|BULL|BEAR)$/.test(base)) continue;
        assets.add(base);
      }
      return [...assets].sort();
    } finally {
      clearTimeout(timer);
    }
  }

  buildPrompt(symbols, nowIso) {
    return `你是加密项目官方 X 重大消息审计员。当前时间：${nowIso}。

审计范围仅限以下 Binance 现货已上线代币代码（必须逐一纳入检索范围）：
${symbols.join(", ")}

检索方法（必须执行）：
1. 对列表中的每个代币分别判断时间窗：先查该项目最近 48 小时；如果该项目没有合格消息，再查该项目第 3-5 天。不能因为同批次其他项目有消息就跳过其第 3-5 天补查。
2. 第一次 x_search 查项目官方账号的重大公告；第二次查创始人、CEO、CTO、CMO 与核心团队的首次披露和未来交付信号；第三次用于第 3-5 天补漏及原帖验证。
3. 搜索时主动覆盖这些未来交付表达及同义词：launching, about to launch, coming, introducing, unveil, reveal, building, shipping, ship, next chapter, under wraps, quiet building, ending hibernation, beta, testnet, mainnet, roadmap，以及“即将推出、正在开发、准备发布、结束蛰伏、进入交付阶段”。

收录规则：
1. 已正式上线的重大产品，也收录项目官方或核心负责人首次明确确认“正在做/即将推出”的新产品、新协议、新功能、新业务方向或重大路线图。
2. 尚未公开产品名或完整功能，但核心负责人明确使用 launching/building/shipping 等交付语言，且内容指向项目级新产品、新协议或新业务方向时，作为 credible_teaser 收录；若是首次披露、实质性高且获项目官方背书，可评 8 分。不能仅因细节尚未公布而过滤。
3. 纯表情、纯倒计时、没有交付含义的“soon”、抽奖、AMA、社区活动、价格观点、小版本更新仍然排除。官方引用或连续帖若只是确认同一件事，合并成一个事件，不要输出多条。
4. 若官方与核心团队发布同一事件，优先使用最早且信息最实质的原帖，并在摘要中说明官方背书；同一事件只输出一次。

评分必须先判断“新颖性”和“实质性”，再参考消息类别：
1. event_novelty 必须选择：new_decision（窗口内新决定）、first_disclosure（首次披露）、new_launch（新产品正式上线）、material_change（已有机制发生实质改变）、milestone（可验证重大里程碑）、ongoing_program（既有计划例行执行）、recap（旧闻、累计数据或媒体再报道）。
2. materiality 必须选择：transformative（改变项目业务/经济结构）、high（新增重要能力、产品线或市场）、moderate（有明确价值但范围有限）、incremental（界面优化、常规集成、小功能或版本迭代）。
3. evidence_strength 必须选择：confirmed（官方明确公布并有事实细节）、credible_teaser（核心负责人明确交付语言且指向项目级事项）、vague（模糊暗示或缺少事实）。
4. 硬性降分：ongoing_program/recap 最高 4 分；incremental 最高 5 分；vague 最高 5 分；credible_teaser 最高 8 分。低于 6 分不得输出。
5. 销毁/回购只有在窗口内首次启动、改变规模/频率/资金来源或作出新的约束性决定，才可评 9-10 分。既有周期销毁、累计销毁数字、媒体重新报道旧机制属于 ongoing_program/recap，最高 4 分。
6. 产品消息只有新增核心能力、协议、产品线、经济用途或重大业务方向才可评 7-8 分。常规 UI、体验优化、有限功能补充、一般集成与换名属于 incremental，最高 5 分。
7. 核心负责人首次明确披露项目级新产品/新业务方向，且项目官方随后确认或背书，即使细节尚未完全公开，也可按 first_disclosure + high + credible_teaser 评 8 分。
8. 必须区分“帖子发布时间”和“事件首次发生/决定时间”。近 2 天的新帖子若只总结旧政策、累计旧数据、引用媒体报道或重复旧公告，不会重置事件新颖性；只有新增决定、参数变化、约束性承诺或首次达到的重大里程碑才算窗口内新事件。

价格催化门槛（这是发送与否的最终门槛）：
1. 这不是技术新闻日报。必须判断消息是否可能在未来数日到数周改变代币供需、协议收入对代币的价值捕获、可进入资金规模、市场准入、真实大规模采用，或重大风险定价。仅仅证明团队在开发、网络更快或功能更多，不构成价格催化。
2. catalyst_type 必须选择：token_supply、token_demand、revenue_value_capture、capital_inflow、market_access、distribution_adoption、material_risk、strategic_new_business、none。
3. catalyst_strength 必须选择 high/moderate/low/none；token_impact 必须选择 direct/credible/indirect/none。必须用 catalyst_path_zh 写出“消息 -> 哪个经济变量变化 -> 为什么可能重估代币”的具体路径。没有具体传导路径，必须标为 low/none。
4. product_change_type 必须选择：new_business、new_consumer_product、protocol_upgrade、hard_fork、testnet_devnet、beta_waitlist、performance_scaling、developer_tooling、ui_feature、not_applicable。
5. protocol_upgrade、hard_fork、testnet/devnet、beta/waitlist、性能扩容、开发者工具、UI/一般功能升级默认最高 5 分。除非公告同时给出可验证的高强度直接催化，例如新增代币消耗、费用回流/销毁、重大资金准入或已有规模承诺的真实采用。
6. 产品已上线、新增若干功能、包含多项 EIP、节点必须升级、主网上线日期确定，都不能单独作为催化依据。不得用“生态增长潜力”“提升采用”“长期利好”这类泛化措辞冒充传导路径。
7. strategic_new_business 仅在核心负责人首次披露项目级全新业务方向、官方背书且预期足以改变市场叙事时例外收录；普通产品版本、单项集成和开发路线不得使用此标签。
8. catalyst_strength 为 low/none、token_impact 为 none/indirect，或 catalyst_type 为 none，最高 5 分，不得输出。产品类消息若既没有高强度直接催化，也不满足 strategic_new_business 首次披露例外，同样最高 5 分。

严格规则：
1. 仅接受项目官方 X，或 CEO/CMO/CTO/创始人/明确核心团队成员的 X 原帖。禁止新闻媒体、交易所公告、聚合账号、KOL、转述。
2. 类别只是最高分参考：tokenomics 最高 10；融资/战略入股最高 9；产品/路线图最高 8；合作/生态最高 8；安全事件最高 9；团队变动最高 7。不得绕过上述新颖性和实质性上限。
3. 普通营销、AMA、社区活动、小版本更新、价格观点、重复提醒不得输出；但不得把具有明确交付含义的重大产品预告误判为普通营销。
4. 每条必须有可直接访问的 x.com/.../status/... 原帖链接、准确发布时间、来源账号。无法验证原帖则丢弃。
5. 使用 x_search 搜索 X，不要使用网页抓取工具。最多 3 次 x_search。不要输出解释或 Markdown，只输出 JSON。

JSON：
{"items":[{"token_name":"项目名","symbol":"代码","score":8,"category":"tokenomics|funding|product|partnership|security|team","event_novelty":"new_decision|first_disclosure|new_launch|material_change|milestone|ongoing_program|recap","materiality":"transformative|high|moderate|incremental","evidence_strength":"confirmed|credible_teaser|vague","catalyst_type":"token_supply|token_demand|revenue_value_capture|capital_inflow|market_access|distribution_adoption|material_risk|strategic_new_business|none","catalyst_strength":"high|moderate|low|none","token_impact":"direct|credible|indirect|none","product_change_type":"new_business|new_consumer_product|protocol_upgrade|hard_fork|testnet_devnet|beta_waitlist|performance_scaling|developer_tooling|ui_feature|not_applicable","catalyst_path_zh":"消息到经济变量再到代币重估的具体路径","score_reason_zh":"一句话说明新事件、实质变化及评分依据","event_key":"同一事件稳定简短标识","announcement_phase":"teaser|announced|launched","summary_zh":"消息核心内容；teaser 需说明已知信息与尚未披露信息","published_at":"ISO-8601","source_account":"@账号","source_role":"project_official|founder|ceo|cto|cmo|core_team","source_url":"https://x.com/账号/status/数字"}]}
无合格消息输出 {"items":[]}。`;
  }

  async run() {
    const now = new Date();
    const universe = await this.getUniverse();
    const allowedSymbols = new Set(universe);
    const batches = chunk(universe, Math.max(30, Math.min(120, Number(this.config.binanceMajorNewsChunkSize || 60))));
    const items = [];
    const diagnostics = [];
    for (let index = 0; index < batches.length; index += 1) {
      try {
        const raw = await this.hermesClient.call(this.buildPrompt(batches[index], now.toISOString()));
        const parsed = extractJson(raw);
        const accepted = (Array.isArray(parsed?.items) ? parsed.items : [])
          .map((item) => normalizeItem(item, allowedSymbols, now.getTime()))
          .filter(Boolean);
        items.push(...accepted);
        diagnostics.push({ batch: index + 1, symbols: batches[index].length, status: "ok", accepted: accepted.length });
        logger.info("binance_major_news_batch_done", {
          batch: index + 1,
          batches: batches.length,
          symbols: batches[index].length,
          accepted: accepted.length
        });
      } catch (error) {
        diagnostics.push({
          batch: index + 1,
          symbols: batches[index].length,
          status: "error",
          error: String(error?.message || error).slice(0, 180)
        });
        logger.warn("binance_major_news_batch_failed", {
          batch: index + 1,
          batches: batches.length,
          error: String(error?.message || error)
        });
      }
    }

    const deduped = [...new Map(items.map((item) => [
      item.event_key ? `${item.symbol}|${item.event_key}` : item.source_url,
      item
    ])).values()]
      .sort((a, b) => b.score - a.score || Date.parse(b.published_at) - Date.parse(a.published_at))
      .slice(0, Math.max(1, Number(this.config.binanceMajorNewsMaxItems || 30)));
    const failures = diagnostics.filter((item) => item.status === "error");
    return {
      status: failures.length === 0 ? "ok" : failures.length === diagnostics.length ? "error" : "partial",
      universeCount: universe.length,
      items: deduped,
      diagnostics,
      error: failures.map((item) => `batch_${item.batch}:${item.error}`).join("; ")
    };
  }
}

export const _test = { extractJson, normalizeItem };
