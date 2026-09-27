import test from "node:test";
import assert from "node:assert/strict";

import { BinanceMajorNewsMonitor, _test } from "../src/binanceMajorNewsMonitor.js";
import { EnginePipeline } from "../src/pipeline.js";

const acquisitionFixture = () => ({
  token_name: "Synthetic Project", symbol: "ABC", score: 10, category: "acquisition",
  acquisition_status: "signed", acquisition_scope: "project_control",
  event_novelty: "first_disclosure", materiality: "transformative", evidence_strength: "confirmed",
  catalyst_type: "none", catalyst_strength: "none", token_impact: "none",
  product_change_type: "not_applicable", catalyst_path_zh: "控制权发生重大变化，代币权益安排未披露",
  summary_zh: "合成测试：收购方签订项目收购协议，金额及代币安排未披露",
  published_at: new Date().toISOString(), source_account: "@example", source_role: "project_official",
  source_url: "https://x.com/example/status/1234567890"
});

test("material confirmed acquisitions survive unknown token economics at score nine", () => {
  for (const acquisition_status of ["signed", "completed", "terminated"]) {
    for (const acquisition_scope of ["project_control", "core_assets"]) {
      const item = _test.normalizeItem({ ...acquisitionFixture(), acquisition_status, acquisition_scope }, new Set(["ABC"]), Date.now());
      assert.equal(item?.score, 9);
      assert.equal(item?.token_impact, "none");
      assert.equal(item?.acquisition_status, acquisition_status);
    }
  }
});

test("acquisition exception rejects rumor, intent, minor stakes, stale news and invalid sources", () => {
  for (const overrides of [
    { acquisition_status: "rumor" }, { acquisition_status: "negotiating" }, { acquisition_status: "unknown" },
    { acquisition_scope: "minority_investment" }, { acquisition_scope: "unknown" },
    { evidence_strength: "credible_teaser" }, { materiality: "incremental" }, { event_novelty: "recap" },
    { source_role: "media" }, { source_account: "@different" },
    { published_at: "2020-01-01T00:00:00Z" }, { category: "funding" }, { category: "partnership" }
  ]) assert.equal(_test.normalizeItem({ ...acquisitionFixture(), ...overrides }, new Set(["ABC"]), Date.now()), null, JSON.stringify(overrides));
});

test("acquisition collection still requires a verified source and report discloses transaction phase", async () => {
  const monitor = new BinanceMajorNewsMonitor({ config: {}, sourceRegistry: {},
    hermesClient: { call: async () => JSON.stringify({ items: [acquisitionFixture()] }) } });
  monitor.getUniverse = async () => ["ABC"];
  assert.equal((await monitor.run()).items.length, 0);
  monitor.sourceRegistry = { ABC: [{ account: "@example", role: "project_official",
    evidence_url: "https://example.org/team", verified_at: "2026-01-01T00:00:00Z" }] };
  const result = await monitor.run();
  assert.equal(result.items.length, 1);
  const pipeline = Object.create(EnginePipeline.prototype);
  pipeline.config = {};
  const message = pipeline.buildBinanceMajorNewsMessages("2026-09-21", result).join("\n");
  assert.match(message, /已签约，尚未交割/);
  assert.match(message, /不等于代币兑付/);
  assert.match(monitor.buildPrompt(["ABC"], new Date().toISOString()), /acquired by/);
});

test("BinanceMajorNewsMonitor builds a unique trading asset universe", async () => {
  const monitor = new BinanceMajorNewsMonitor({
    config: { binanceBaseUrl: "https://example.test", binanceMajorNewsTimeoutSec: 5 },
    hermesClient: null,
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        symbols: [
          { status: "TRADING", isSpotTradingAllowed: true, baseAsset: "BTC" },
          { status: "TRADING", isSpotTradingAllowed: true, baseAsset: "BTC" },
          { status: "TRADING", isSpotTradingAllowed: true, baseAsset: "USDT" },
          { status: "BREAK", isSpotTradingAllowed: true, baseAsset: "OLD" },
          { status: "TRADING", isSpotTradingAllowed: false, baseAsset: "NOPE" }
        ]
      })
    })
  });

  assert.deepEqual(await monitor.getUniverse(), ["BTC"]);
});

test("normalizeItem accepts material new events with direct X status links", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const base = {
    token_name: "Example",
    symbol: "ABC",
    score: 8,
    category: "funding",
    event_novelty: "new_decision",
    materiality: "high",
    evidence_strength: "confirmed",
    catalyst_type: "capital_inflow",
    catalyst_strength: "high",
    token_impact: "credible",
    product_change_type: "not_applicable",
    catalyst_path_zh: "新增战略资金进入项目并扩大可用于增长的资本规模",
    score_reason_zh: "本轮首次公布战略融资",
    summary_zh: "完成战略融资",
    published_at: "2026-08-19T12:00:00.000Z",
    source_account: "@example",
    source_role: "project_official",
    source_url: "https://x.com/example/status/1234567890"
  };

  assert.equal(_test.normalizeItem(base, new Set(["ABC"]), now)?.symbol, "ABC");
  assert.equal(_test.normalizeItem({ ...base, source_url: "https://example.com/news" }, new Set(["ABC"]), now), null);
  assert.equal(_test.normalizeItem({ ...base, symbol: "OTHER" }, new Set(["ABC"]), now), null);
});

test("normalizeItem rejects CAKE-style coverage of an existing burn program", () => {
  const item = {
    token_name: "PancakeSwap", symbol: "CAKE", score: 10, category: "tokenomics",
    event_novelty: "ongoing_program", materiality: "moderate", evidence_strength: "confirmed",
    catalyst_type: "token_supply", catalyst_strength: "moderate", token_impact: "direct",
    product_change_type: "not_applicable", catalyst_path_zh: "既有周期销毁继续减少供应但没有新增参数",
    published_at: "2026-08-19T12:00:00.000Z", source_account: "@PancakeSwap",
    source_url: "https://x.com/PancakeSwap/status/1234567890"
  };
  assert.equal(_test.normalizeItem(item, new Set(["CAKE"]), Date.parse("2026-08-20T12:00:00Z")), null);
});

test("normalizeItem rejects ENS/MANTRA-style incremental product upgrades", () => {
  const item = {
    token_name: "Example", symbol: "ENS", score: 8, category: "product",
    event_novelty: "new_launch", materiality: "incremental", evidence_strength: "confirmed",
    catalyst_type: "none", catalyst_strength: "none", token_impact: "none",
    product_change_type: "ui_feature", catalyst_path_zh: "只改善管理体验，没有代币经济变量变化",
    published_at: "2026-08-19T12:00:00.000Z", source_account: "@ensdomains",
    source_url: "https://x.com/ensdomains/status/1234567890"
  };
  assert.equal(_test.normalizeItem(item, new Set(["ENS"]), Date.parse("2026-08-20T12:00:00Z")), null);
});

test("normalizeItem keeps a Scroll-style first disclosure at score 8", () => {
  const item = {
    token_name: "Scroll", symbol: "SCR", score: 8, category: "product",
    event_novelty: "first_disclosure", materiality: "high", evidence_strength: "credible_teaser",
    catalyst_type: "strategic_new_business", catalyst_strength: "high", token_impact: "credible",
    product_change_type: "new_business", catalyst_path_zh: "项目结束长期静默并首次进入全新业务交付阶段，可能重估项目叙事",
    score_reason_zh: "核心负责人首次披露项目级新交付方向，官方随后背书",
    published_at: "2026-08-17T11:06:20.390Z", source_account: "@razacodes", source_role: "ceo",
    source_url: "https://x.com/razacodes/status/2089307836706869758"
  };
  const normalized = _test.normalizeItem(item, new Set(["SCR"]), Date.parse("2026-08-21T00:00:00Z"));
  assert.equal(normalized?.score, 8);
  assert.equal(normalized?.event_novelty, "first_disclosure");
});

for (const example of [
  ["RUNE", "protocol_upgrade"],
  ["BNB", "hard_fork"],
  ["EGLD", "performance_scaling"],
  ["VET", "protocol_upgrade"],
  ["DUSK", "testnet_devnet"]
]) {
  test(`normalizeItem rejects ${example[0]}-style engineering delivery without a price catalyst`, () => {
    const item = {
      token_name: example[0], symbol: example[0], score: 8, category: "product",
      event_novelty: "new_launch", materiality: "high", evidence_strength: "confirmed",
      catalyst_type: "none", catalyst_strength: "low", token_impact: "indirect",
      product_change_type: example[1], catalyst_path_zh: "可能改善网络能力，但没有可验证的代币经济传导路径",
      published_at: "2026-08-20T12:00:00.000Z", source_account: "@project",
      source_url: "https://x.com/project/status/1234567890"
    };
    assert.equal(_test.normalizeItem(item, new Set([example[0]]), Date.parse("2026-08-21T00:00:00Z")), null);
  });
}

test("normalizeItem keeps a product launch with direct token demand", () => {
  const item = {
    token_name: "Example", symbol: "ABC", score: 8, category: "product",
    event_novelty: "new_launch", materiality: "high", evidence_strength: "confirmed",
    catalyst_type: "token_demand", catalyst_strength: "high", token_impact: "direct",
    product_change_type: "new_consumer_product",
    source_role: "project_official",
    catalyst_path_zh: "新产品使用必须消耗 ABC，已公布的用户规模会直接增加代币需求",
    published_at: "2026-08-20T12:00:00.000Z", source_account: "@example",
    source_url: "https://x.com/example/status/1234567890"
  };
  assert.equal(_test.normalizeItem(item, new Set(["ABC"]), Date.parse("2026-08-21T00:00:00Z"))?.score, 8);
});

test("extractJson accepts fenced Hermes JSON", () => {
  assert.deepEqual(_test.extractJson('```json\n{"items":[]}\n```'), { items: [] });
});

test("buildPrompt includes substantive teaser discovery and per-token fallback", () => {
  const monitor = new BinanceMajorNewsMonitor({ config: {}, hermesClient: null });
  const prompt = monitor.buildPrompt(["SCR"], "2026-08-21T00:00:00.000Z");
  assert.match(prompt, /每个代币分别判断时间窗/);
  assert.match(prompt, /launching, about to launch/);
  assert.match(prompt, /可评 8 分/);
  assert.match(prompt, /ongoing_program\/recap 最高 4 分/);
  assert.match(prompt, /常规 UI、体验优化/);
  assert.match(prompt, /区分“帖子发布时间”和“事件首次发生\/决定时间”/);
  assert.match(prompt, /这不是技术新闻日报/);
  assert.match(prompt, /hard_fork、testnet\/devnet/);
  assert.match(prompt, /消息 -> 哪个经济变量变化/);
  assert.match(prompt, /同一事件只输出一次/);
});


const verifiedAccount = (overrides = {}) => ({ account: "@example", role: "project_official",
  evidence_url: "https://example.org/team", verified_at: "2026-01-01T00:00:00Z", ...overrides });

test("empty source registry skips all paid calls and keeps the full universe missing", async () => {
  let calls = 0;
  const monitor = new BinanceMajorNewsMonitor({ config: { binanceMajorNewsChunkSize: 60 }, sourceRegistry: {},
    hermesClient: { call: async () => { calls++; throw Error("must not call paid provider"); } } });
  monitor.getUniverse = async () => Array.from({ length: 480 }, (_, i) => `FIX${i}`);
  const result = await monitor.run();
  assert.equal(calls, 0);
  assert.equal(result.universeCount, 480);
  assert.equal(result.status, "partial");
  assert.equal(result.diagnostics.length, 8);
  assert.equal(result.diagnostics.reduce((n, d) => n + d.symbols_without_verified_sources, 0), 480);
  assert.ok(result.diagnostics.every(d => d.error === "source_identity_unverified" && d.searched_symbols === 0));
  assert.deepEqual(result.items, []);
  const pipeline=Object.create(EnginePipeline.prototype);pipeline.config={};
  const message=pipeline.buildBinanceMajorNewsMessages("2026-09-27",result).join("\n");
  assert.match(message,/未执行付费搜索，重大消息结果未知/);
  assert.doesNotMatch(message,/今日无重大消息|已完成部分未发现/);
});

test("invalid affiliation records cannot admit a paid request", async () => {
  let calls = 0;
  const symbols = ["ROLE", "FUTURE", "URL", "ACCOUNT", "NUMBER", "EMPTY"];
  const sourceRegistry = {
    ROLE: [verifiedAccount({role:"media"})],
    FUTURE: [verifiedAccount({verified_at:new Date(Date.now()+86400000).toISOString()})],
    URL: [verifiedAccount({evidence_url:"http://127.0.0.1/team"})],
    ACCOUNT: [verifiedAccount({account:"@not-valid!"})], NUMBER: [verifiedAccount({account:123})], EMPTY: [],
  };
  const monitor = new BinanceMajorNewsMonitor({config:{},sourceRegistry,
    hermesClient:{call:async()=>{calls++;return '{"items":[]}';}}});
  monitor.getUniverse=async()=>symbols;
  const result=await monitor.run();
  assert.equal(calls,0);
  assert.equal(result.diagnostics[0].symbols_without_verified_sources,6);
});

test("partial source coverage searches only verified batch symbols without shrinking denominator or accepting another batch", async () => {
  const requested=[];let calls=0;
  const sourceRegistry={ABC:[verifiedAccount()],BTC:[verifiedAccount()]};
  const monitor=new BinanceMajorNewsMonitor({config:{binanceMajorNewsChunkSize:30},sourceRegistry,
    hermesClient:{call:async()=>{
      calls++;
      return JSON.stringify({items: calls===1
        ? [{...acquisitionFixture(),event_key:"abc-good"},{...acquisitionFixture(),symbol:"BTC",event_key:"cross-batch-1"}]
        : [{...acquisitionFixture(),symbol:"BTC",event_key:"btc-good"},{...acquisitionFixture(),event_key:"cross-batch-2"}]});
    }}});
  monitor.getUniverse=async()=>["ABC",...Array.from({length:29},(_,i)=>`FIX${i}`),"BTC"];
  const build=monitor.buildPrompt.bind(monitor);
  monitor.buildPrompt=(symbols,now)=>{requested.push(symbols);return build(symbols,now);};
  const result=await monitor.run();
  assert.deepEqual(requested,[["ABC"],["BTC"]]);
  assert.equal(calls,2);
  assert.equal(result.universeCount,31);
  assert.equal(result.status,"partial");
  assert.equal(result.diagnostics[0].symbols,30);
  assert.equal(result.diagnostics[0].searched_symbols,1);
  assert.equal(result.diagnostics[0].symbols_without_verified_sources,29);
  assert.equal(result.diagnostics[1].symbols,1);
  assert.deepEqual(result.items.map(i=>i.event_key).sort(),["abc-good","btc-good"]);
});

test("admitted symbols still reject provider results from unregistered source accounts",async()=>{
  const monitor=new BinanceMajorNewsMonitor({config:{},sourceRegistry:{ABC:[verifiedAccount()]},
    hermesClient:{call:async()=>JSON.stringify({items:[{...acquisitionFixture(),source_account:"@outsider",source_url:"https://x.com/outsider/status/123"}]})}});
  monitor.getUniverse=async()=>["ABC"];
  const result=await monitor.run();
  assert.equal(result.status,"partial");
  assert.equal(result.diagnostics[0].unverified_sources,1);
  assert.deepEqual(result.items,[]);
});
