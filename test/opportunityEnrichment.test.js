import assert from "node:assert/strict";
import test from "node:test";
import {
  crawlOfficialPage,
  enrichOpportunities,
  extractDeadlineFromText,
  extractHtmlLinks,
  findOfficialUrl,
  inferOfficialUrl,
  isOfficialOpportunityUrl,
  pickOfficialAnnouncementLinks
} from "../src/opportunityEnrichment.js";

const NOW = new Date("2026-06-10T08:00:00.000Z");

function baseItem(overrides = {}) {
  return {
    dedup_key: "test",
    activity_name: "Gate SpaceX IPO Access",
    type: "pre_ipo",
    section: "cex",
    exchange: "Gate",
    venue: "IPO Access",
    asset: "USDT",
    stablecoin: "USDT",
    apy: null,
    expected_yield: "Pre-IPO allocation",
    reward: "SpaceX exposure",
    duration: "",
    deadline_at: null,
    source_published_at: "2026-06-10T01:00:00.000Z",
    participation: "Open official page https://www.gate.com/announcements/article/123",
    source_user: "@Gate",
    source_url: "https://x.com/Gate/status/1",
    credibility: "official",
    risk_note: "High risk",
    status: "unverified",
    ...overrides
  };
}

test("extractDeadlineFromText parses deadline contexts from official page text", () => {
  const result = extractDeadlineFromText(
    "Campaign Period: June 9 to 12, 2026 (UTC). Rewards will be distributed later.",
    NOW
  );

  assert.equal(result.deadline_at, "2026-06-12T23:59:59.000Z");
  assert.equal(result.deadline_source, "official_page");
  assert.equal(result.deadline_confidence, 0.9);
});

test("extractDeadlineFromText converts UTC offset deadlines to UTC", () => {
  const result = extractDeadlineFromText(
    "Campaign Period: 2026-06-10 10:00 - 2026-06-15 23:59 (UTC+8)",
    NOW
  );

  assert.equal(result.deadline_at, "2026-06-15T15:59:59.000Z");
  assert.equal(result.deadline_text, "2026-06-15 23:59");
});

test("extractDeadlineFromText parses Chinese partial date ranges with UTC offsets", () => {
  const result = extractDeadlineFromText(
    "活动时间：2026年6月10日16:00 至 6月15日23:59（UTC+8）",
    NOW
  );

  assert.equal(result.deadline_at, "2026-06-15T15:59:59.000Z");
  assert.equal(result.deadline_text, "2026年6月10日16:00 至 6月15日23:59");
});

test("extractDeadlineFromText keeps explicit UTC English ranges unchanged", () => {
  const result = extractDeadlineFromText(
    "Subscription Period: June 10, 2026 10:00 UTC to June 15, 2026 23:59 UTC",
    NOW
  );

  assert.equal(result.deadline_at, "2026-06-15T23:59:59.000Z");
  assert.equal(result.deadline_source, "official_page");
});

test("crawlOfficialPage rejects anti-bot placeholder pages", async () => {
  await assert.rejects(
    () =>
      crawlOfficialPage("https://www.binance.com/en/support/announcement/detail/example", {
        fetchFn: async () => ({
          ok: true,
          url: "https://www.binance.com/en/support/announcement/detail/example",
          text: async () =>
            "<html><body>JavaScript is disabled In order to continue, we need to verify that you're not a robot.</body></html>"
        })
      }),
    /official_fetch_blocked_or_empty/
  );
});

test("crawlOfficialPage preserves deadline-bearing attributes for parsing", async () => {
  const page = await crawlOfficialPage("https://www.gate.com/announcements/article/hidden-deadline", {
    fetchFn: async () => ({
      ok: true,
      url: "https://www.gate.com/announcements/article/hidden-deadline",
      text: async () =>
        '<html><body><div data-end-time="2026-06-15 23:59 UTC+8">Subscribe now</div></body></html>'
    })
  });
  const result = extractDeadlineFromText(page.text, NOW);

  assert.equal(result.deadline_at, "2026-06-15T15:59:59.000Z");
  assert.match(page.text, /data-end-time/);
});

test("crawlOfficialPage preserves JSON script campaign periods for parsing", async () => {
  const page = await crawlOfficialPage("https://www.binance.com/en/support/announcement/detail/json-deadline", {
    fetchFn: async () => ({
      ok: true,
      url: "https://www.binance.com/en/support/announcement/detail/json-deadline",
      text: async () =>
        '<html><body><div>Join now</div><script type="application/json">{"campaignPeriod":"2026-06-10 10:00 - 2026-06-22 23:59 (UTC)"}</script></body></html>'
    })
  });
  const result = extractDeadlineFromText(page.text, NOW);

  assert.equal(result.deadline_at, "2026-06-22T23:59:59.000Z");
  assert.match(page.text, /campaign Period/);
});

test("extractHtmlLinks resolves relative official links", () => {
  const links = extractHtmlLinks(
    '<a href="/announcements/article/gate-spacex-ipo-access">SpaceX</a><a href="https://x.com/Gate/status/1">X</a>',
    "https://www.gate.com/ipo-access"
  );

  assert.deepEqual(links, [
    "https://www.gate.com/announcements/article/gate-spacex-ipo-access"
  ]);
});

test("findOfficialUrl keeps CEX links on official domains only", () => {
  const item = baseItem({
    raw_json: JSON.stringify({
      official_url: "https://www.gate.com/announcements/article/123",
      source_url: "https://x.com/Gate/status/1"
    })
  });

  assert.equal(isOfficialOpportunityUrl("https://x.com/Gate/status/1", item), false);
  assert.equal(findOfficialUrl(item), "https://www.gate.com/announcements/article/123");
});

test("pickOfficialAnnouncementLinks ranks relevant official announcement links only", () => {
  const item = baseItem({
    activity_name: "Gate SpaceX IPO Access",
    participation: "Open Gate IPO Access page",
    official_url: "https://www.gate.com/ipo-access"
  });
  const links = pickOfficialAnnouncementLinks(
    [
      "https://x.com/Gate/status/1",
      "https://www.gate.com/",
      "https://www.gate.com/announcements/article/gate-spacex-ipo-access",
      "https://www.gate.com/announcements/article/random-campaign"
    ],
    item,
    2
  );

  assert.deepEqual(links, [
    "https://www.gate.com/announcements/article/gate-spacex-ipo-access",
    "https://www.gate.com/announcements/article/random-campaign"
  ]);
});

test("inferOfficialUrl returns conservative product pages for known venues", () => {
  assert.deepEqual(
    inferOfficialUrl(
      baseItem({
        activity_name: "Binance USD1 Simple Earn Flexible",
        exchange: "Binance",
        venue: "Simple Earn",
        participation: "Subscribe USD1 Flexible Products"
      })
    ),
    {
      url: "https://www.binance.com/en/support/announcement/detail/9ee205049edd4b91887b8610bce0c2ab",
      source: "official_page"
    }
  );

  assert.deepEqual(
    inferOfficialUrl(
      baseItem({
        exchange: "Bybit",
        venue: "Fixed Earn",
        participation: "EU users only; subscribe Bybit EU Fixed/Easy Earn USDC via bybit.eu earn pages"
      })
    ),
    { url: "https://www.bybit.eu/en-EU/earn", source: "official_product" }
  );

  assert.deepEqual(
    inferOfficialUrl(
      baseItem({
        activity_name: "Bybit Football Season 2026 Predict & Earn",
        exchange: "Bybit",
        venue: "Prediction platform",
        participation: "Predict matches, earn points, compete"
      })
    ),
    {
      url: "https://announcements.bybitglobal.com/en/article/bybit-football-season-2026-trade-predict-win-from-1-000-000-in-rewards--bltf8a798fbfccc3a6d/",
      source: "official_page"
    }
  );

  assert.deepEqual(
    inferOfficialUrl(
      baseItem({
        activity_name: "Bybit IPO Express - SpaceX Tokenized Shares",
        exchange: "Bybit",
        venue: "IPO Express"
      })
    ),
    {
      url: "https://announcements.bybit.com/en/article/introducing-spacex-the-first-ipo-on-bybit-ipo-express-blt360da1ebb3f31f8a/",
      source: "official_page"
    }
  );

  assert.deepEqual(
    inferOfficialUrl(
      baseItem({
        activity_name: "Permapod USDC链上信贷市场",
        type: "stablecoin_earn",
        section: "onchain",
        exchange: "",
        venue: "Ethereum"
      })
    ),
    { url: "https://app.permapod.xyz", source: "official_product" }
  );

  assert.deepEqual(
    inferOfficialUrl(
      baseItem({
        activity_name: "Edel Finance USDC Aave供给收益",
        type: "stablecoin_earn",
        section: "onchain",
        exchange: "",
        venue: "Ethereum"
      })
    ),
    { url: "https://app.edel.finance", source: "official_product" }
  );

  assert.deepEqual(
    inferOfficialUrl(
      baseItem({
        activity_name: "Zoth Base USDC/USDT zOPAL积分",
        type: "short_term",
        section: "onchain",
        exchange: "",
        venue: "Base"
      })
    ),
    { url: "https://zoth.io/zvault", source: "official_product" }
  );
});

test("enrichOpportunities crawls official pages and upgrades deadline status", async () => {
  const fetchFn = async () => ({
    ok: true,
    url: "https://www.gate.com/announcements/article/123",
    text: async () => "<html><body>Subscription Period: June 9 to 12, 2026 UTC</body></html>"
  });

  const [item] = await enrichOpportunities([baseItem()], {
    now: NOW,
    fetchFn,
    config: {
      opportunityEnrichmentEnabled: true,
      opportunityEnrichmentMaxItems: 5,
      opportunityOfficialCrawlTimeoutSec: 1,
      opportunityGrokDeadlineFallbackEnabled: false
    }
  });

  assert.equal(item.deadline_at, "2026-06-12T23:59:59.000Z");
  assert.equal(item.deadline_source, "official_page");
  assert.equal(item.official_url, "https://www.gate.com/announcements/article/123");
  assert.equal(item.status, "active");
});

test("enrichOpportunities discovers linked official announcements from product pages", async () => {
  const fetchedUrls = [];
  const [item] = await enrichOpportunities(
    [
      baseItem({
        activity_name: "Gate SpaceX IPO Access",
        participation: "Open Gate IPO Access page",
        raw_json: "{}",
        official_url: null,
        official_url_source: null,
        deadline_at: null
      })
    ],
    {
      now: NOW,
      fetchFn: async (url) => {
        fetchedUrls.push(url);
        if (url === "https://www.gate.com/ipo-access") {
          return {
            ok: true,
            url,
            text: async () =>
              '<html><body><a href="/announcements/article/gate-spacex-ipo-access">Gate SpaceX IPO Access announcement</a></body></html>'
          };
        }
        return {
          ok: true,
          url,
          text: async () => "<html><body>Subscription Period: June 10 to 15, 2026 UTC</body></html>"
        };
      },
      config: {
        opportunityEnrichmentEnabled: true,
        opportunityEnrichmentMaxItems: 5,
        opportunityOfficialCrawlTimeoutSec: 1,
        opportunityGrokDeadlineFallbackEnabled: false
      }
    }
  );

  assert.deepEqual(fetchedUrls, [
    "https://www.gate.com/ipo-access",
    "https://www.gate.com/announcements/article/gate-spacex-ipo-access"
  ]);
  assert.equal(item.official_url, "https://www.gate.com/announcements/article/gate-spacex-ipo-access");
  assert.equal(item.official_url_source, "official_page");
  assert.equal(item.deadline_at, "2026-06-15T23:59:59.000Z");
  assert.equal(item.deadline_source, "official_page");
  assert.equal(item.status, "active");
});

test("enrichOpportunities infers official onchain product links without crawling them", async () => {
  let fetchCalls = 0;
  const [item] = await enrichOpportunities(
    [
      baseItem({
        activity_name: "Pendle stablecoin LP/PT yield",
        type: "onchain",
        section: "onchain",
        exchange: "",
        venue: "Pendle",
        stablecoin: "USDC",
        expected_yield: "Double-digit fixed yield",
        participation: "Use Pendle app markets",
        source_user: "@pendle_fi",
        source_url: "https://x.com/pendle_fi/status/1",
        credibility: "kol",
        status: "unverified"
      })
    ],
    {
      now: NOW,
      fetchFn: async () => {
        fetchCalls += 1;
        throw new Error("inferred_product_page_should_not_be_crawled");
      },
      config: {
        opportunityEnrichmentEnabled: true,
        opportunityEnrichmentMaxItems: 5,
        opportunityGrokDeadlineFallbackEnabled: false
      }
    }
  );

  assert.equal(fetchCalls, 0);
  assert.equal(item.official_url, "https://app.pendle.finance");
  assert.equal(item.official_url_source, "official_product");
  assert.equal(item.deadline_source, "no_fixed_deadline");
  assert.equal(item.status, "active");
});

test("enrichOpportunities marks onchain stablecoin product yields as no fixed deadline", async () => {
  const [item] = await enrichOpportunities(
    [
      baseItem({
        activity_name: "Permapod USDC链上信贷市场",
        type: "stablecoin_earn",
        section: "onchain",
        exchange: "",
        venue: "Ethereum",
        stablecoin: "USDC",
        apy: 15,
        expected_yield: "USDC up to 15% APY",
        participation: "Deposit USDC into PermaPod",
        source_user: "@PermaPod_xyz",
        source_url: "https://x.com/PermaPod_xyz/status/1",
        credibility: "official",
        status: "unverified"
      })
    ],
    {
      now: NOW,
      fetchFn: async () => {
        throw new Error("inferred_product_page_should_not_be_crawled");
      },
      config: {
        opportunityEnrichmentEnabled: true,
        opportunityEnrichmentMaxItems: 5,
        opportunityGrokDeadlineFallbackEnabled: false
      }
    }
  );

  assert.equal(item.official_url, "https://app.permapod.xyz");
  assert.equal(item.official_url_source, "official_product");
  assert.equal(item.deadline_source, "no_fixed_deadline");
  assert.equal(item.deadline_at, null);
  assert.equal(item.status, "active");
});

test("enrichOpportunities marks supported CEX ongoing products as no fixed deadline", async () => {
  const [item] = await enrichOpportunities(
    [
      baseItem({
        activity_name: "Bybit EU Fixed Earn USDC High APR",
        type: "stablecoin_earn",
        section: "cex",
        exchange: "Bybit",
        venue: "Fixed Earn",
        stablecoin: "USDC",
        apy: 16,
        participation: "EU users only; subscribe Bybit EU Fixed/Easy Earn USDC via bybit.eu earn pages",
        source_user: "@BybitNordic",
        source_url: "https://x.com/BybitNordic/status/1",
        credibility: "official",
        status: "unverified",
        official_url: "https://www.bybit.eu/en-EU/earn",
        official_url_source: "official_product",
        deadline_at: null
      })
    ],
    {
      now: NOW,
      fetchFn: async () => {
        throw new Error("product_page_should_not_be_crawled");
      },
      config: {
        opportunityEnrichmentEnabled: true,
        opportunityEnrichmentMaxItems: 5,
        opportunityGrokDeadlineFallbackEnabled: false
      }
    }
  );

  assert.equal(item.deadline_at, null);
  assert.equal(item.deadline_source, "no_fixed_deadline");
  assert.equal(item.status, "active");
});

test("enrichOpportunities crawls inferred official announcement pages", async () => {
  let fetchedUrl = "";
  const [item] = await enrichOpportunities(
    [
      baseItem({
        activity_name: "Binance Wallet Football Trading Cup",
        type: "short_term",
        section: "cex",
        exchange: "Binance",
        venue: "Binance Wallet",
        participation: "Open Binance Wallet campaign banner",
        source_user: "@BinanceWallet",
        source_url: "https://x.com/BinanceWallet/status/1",
        credibility: "official",
        status: "unverified",
        deadline_at: null,
        official_url: null
      })
    ],
    {
      now: NOW,
      fetchFn: async (url) => {
        fetchedUrl = url;
        return {
          ok: true,
          url,
          text: async () =>
            "<html><body>Registration Period: 2026-06-09 04:00 - 2026-07-27 08:00 (UTC)</body></html>"
        };
      },
      config: {
        opportunityEnrichmentEnabled: true,
        opportunityEnrichmentMaxItems: 5,
        opportunityOfficialCrawlTimeoutSec: 1,
        opportunityGrokDeadlineFallbackEnabled: false
      }
    }
  );

  assert.equal(
    fetchedUrl,
    "https://www.binance.com/en/support/announcement/detail/92b1c5c7761443309c8594185a5e8989"
  );
  assert.equal(item.official_url, fetchedUrl);
  assert.equal(item.official_url_source, "official_page");
  assert.equal(item.deadline_at, "2026-07-27T08:00:59.000Z");
  assert.equal(item.deadline_source, "official_page");
});

test("enrichOpportunities upgrades product links to inferred official announcement pages", async () => {
  const [item] = await enrichOpportunities(
    [
      baseItem({
        activity_name: "Binance USD1 Simple Earn Flexible",
        type: "stablecoin_earn",
        section: "cex",
        exchange: "Binance",
        venue: "Simple Earn",
        stablecoin: "USD1",
        apy: 10.5,
        participation: "Subscribe USD1 Flexible Products",
        source_user: "@binance",
        source_url: "https://x.com/binance/status/1",
        credibility: "official",
        status: "unverified",
        official_url: "https://www.binance.com/en/earn",
        official_url_source: "official_product",
        deadline_at: null
      })
    ],
    {
      now: NOW,
      fetchFn: async (url) => ({
        ok: true,
        url,
        text: async () =>
          "<html><body>Promotion Period: 2026-06-09 00:00:00 (UTC) to 2026-06-22 23:59:59 (UTC)</body></html>"
      }),
      config: {
        opportunityEnrichmentEnabled: true,
        opportunityEnrichmentMaxItems: 5,
        opportunityOfficialCrawlTimeoutSec: 1,
        opportunityGrokDeadlineFallbackEnabled: false
      }
    }
  );

  assert.equal(
    item.official_url,
    "https://www.binance.com/en/support/announcement/detail/9ee205049edd4b91887b8610bce0c2ab"
  );
  assert.equal(item.official_url_source, "official_page");
  assert.equal(item.deadline_at, "2026-06-22T23:59:59.000Z");
  assert.equal(item.deadline_source, "official_page");
});

test("enrichOpportunities upgrades Bybit prediction product links to campaign announcements", async () => {
  const [item] = await enrichOpportunities(
    [
      baseItem({
        activity_name: "Bybit Football Season 2026 Predict & Earn",
        type: "short_term",
        section: "cex",
        exchange: "Bybit",
        venue: "Prediction platform",
        participation: "Predict matches, earn points, compete",
        source_user: "@Bybit_Official",
        source_url: "https://x.com/Bybit_Official/status/1",
        credibility: "official",
        status: "active",
        official_url: "https://www.bybit.com/en/prediction",
        official_url_source: "official_product",
        deadline_at: null
      })
    ],
    {
      now: NOW,
      fetchFn: async (url) => ({
        ok: true,
        url,
        text: async () =>
          "<html><body>Event period: Jun 9, 2026, 10AM UTC - Jul 19, 2026, 11:59PM UTC</body></html>"
      }),
      config: {
        opportunityEnrichmentEnabled: true,
        opportunityEnrichmentMaxItems: 5,
        opportunityOfficialCrawlTimeoutSec: 1,
        opportunityGrokDeadlineFallbackEnabled: false
      }
    }
  );

  assert.equal(
    item.official_url,
    "https://announcements.bybitglobal.com/en/article/bybit-football-season-2026-trade-predict-win-from-1-000-000-in-rewards--bltf8a798fbfccc3a6d/"
  );
  assert.equal(item.official_url_source, "official_page");
  assert.equal(item.deadline_at, "2026-07-19T23:59:59.000Z");
  assert.equal(item.deadline_source, "official_page");
});

test("enrichOpportunities falls back to Grok when official URL is missing", async () => {
  const [item] = await enrichOpportunities(
    [
      baseItem({
        participation: "Open the app event center",
        raw_json: "{}"
      })
    ],
    {
      now: NOW,
      config: {
        opportunityEnrichmentEnabled: true,
        opportunityEnrichmentMaxItems: 5,
        opportunityOfficialCrawlTimeoutSec: 1,
        opportunityGrokDeadlineFallbackEnabled: true,
        opportunityGrokDeadlineFallbackMax: 1
      },
      fetchFn: async () => {
        throw new Error("product_page_should_not_be_crawled");
      },
      callHermes: async () =>
        JSON.stringify({
          official_url: "https://www.gate.com/announcements/article/456",
          deadline_at: "2026-06-13T23:59:59.000Z",
          deadline_text: "Ends June 13, 2026 UTC",
          deadline_source: "grok",
          deadline_confidence: 0.6,
          participation: "在 Gate 活动中心认购"
        })
    }
  );

  assert.equal(item.deadline_at, "2026-06-13T23:59:59.000Z");
  assert.equal(item.deadline_source, "grok");
  assert.equal(item.deadline_confidence, 0.6);
  assert.equal(item.official_url, "https://www.gate.com/announcements/article/456");
  assert.equal(item.participation, "在 Gate 活动中心认购");
});

test("enrichOpportunities marks no fixed deadline separately when fallback confirms it", async () => {
  const [item] = await enrichOpportunities(
    [
      baseItem({
        participation: "Open the app event center",
        raw_json: "{}"
      })
    ],
    {
      now: NOW,
      config: {
        opportunityEnrichmentEnabled: true,
        opportunityEnrichmentMaxItems: 5,
        opportunityGrokDeadlineFallbackEnabled: true,
        opportunityGrokDeadlineFallbackMax: 1
      },
      fetchFn: async () => {
        throw new Error("product_page_should_not_be_crawled");
      },
      callHermes: async () =>
        JSON.stringify({
          deadline_at: null,
          deadline_source: "x_post",
          deadline_confidence: 65,
          participation: "活动持续中，官方未注明固定截止"
        })
    }
  );

  assert.equal(item.deadline_at, null);
  assert.equal(item.deadline_source, "no_fixed_deadline");
  assert.equal(item.deadline_confidence, 0.65);
  assert.equal(item.deadline_text, "活动持续中，官方未注明固定截止");
  assert.equal(item.participation, "活动持续中，官方未注明固定截止");
});

test("enrichOpportunities keeps deadline source empty when fallback has no deadline evidence", async () => {
  const [item] = await enrichOpportunities([baseItem({ participation: "Open app event center", raw_json: "{}" })], {
    now: NOW,
    config: {
      opportunityEnrichmentEnabled: true,
      opportunityEnrichmentMaxItems: 5,
      opportunityGrokDeadlineFallbackEnabled: true,
      opportunityGrokDeadlineFallbackMax: 1
    },
    callHermes: async () =>
      JSON.stringify({
        deadline_at: null,
        deadline_source: "x_post",
        deadline_confidence: 65,
        participation: "Open app event center"
      })
  });

  assert.equal(item.deadline_at, null);
  assert.equal(item.deadline_source, null);
  assert.equal(item.deadline_confidence, null);
});
