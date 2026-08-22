import assert from "node:assert/strict";
import test from "node:test";

test("config defaults Level2 threshold to V1 value 60 without relying on .env", async () => {
  const original = process.env.LEVEL2_THRESHOLD;
  process.env.LEVEL2_THRESHOLD = "";

  try {
    const { config } = await import(`../src/config.js?level2-default=${Date.now()}`);
    assert.equal(config.level2Threshold, 60);
  } finally {
    if (original === undefined) {
      delete process.env.LEVEL2_THRESHOLD;
    } else {
      process.env.LEVEL2_THRESHOLD = original;
    }
  }
});

test("config exposes opportunity monitor defaults", async () => {
  const original = {
    OPPORTUNITY_MONITOR_ENABLED: process.env.OPPORTUNITY_MONITOR_ENABLED,
    OPPORTUNITY_INTERVAL_SEC: process.env.OPPORTUNITY_INTERVAL_SEC,
    OPPORTUNITY_SCHEDULE_MODE: process.env.OPPORTUNITY_SCHEDULE_MODE,
    OPPORTUNITY_COLLECTION_TYPES: process.env.OPPORTUNITY_COLLECTION_TYPES,
    OPPORTUNITY_DAILY_REPORT_ENABLED: process.env.OPPORTUNITY_DAILY_REPORT_ENABLED,
    OPPORTUNITY_DAILY_REPORT_TIME_BJ: process.env.OPPORTUNITY_DAILY_REPORT_TIME_BJ,
    OPPORTUNITY_LOOKBACK_HOURS: process.env.OPPORTUNITY_LOOKBACK_HOURS,
    OPPORTUNITY_HERMES_PROFILE: process.env.OPPORTUNITY_HERMES_PROFILE,
    OPPORTUNITY_HERMES_TIMEOUT_SEC: process.env.OPPORTUNITY_HERMES_TIMEOUT_SEC,
    XINTEL_HERMES_MAX_CONCURRENCY: process.env.XINTEL_HERMES_MAX_CONCURRENCY,
    XINTEL_HERMES_MIN_INTERVAL_MS: process.env.XINTEL_HERMES_MIN_INTERVAL_MS,
    OPPORTUNITY_STALE_AFTER_HOURS: process.env.OPPORTUNITY_STALE_AFTER_HOURS,
    OPPORTUNITY_MAX_FOLLOWUPS: process.env.OPPORTUNITY_MAX_FOLLOWUPS,
    OPPORTUNITY_FOCUSED_QUERIES_ENABLED: process.env.OPPORTUNITY_FOCUSED_QUERIES_ENABLED,
    OPPORTUNITY_QUERY_MATRIX_ENABLED: process.env.OPPORTUNITY_QUERY_MATRIX_ENABLED,
    OPPORTUNITY_ADAPTIVE_QUERY_PLAN_ENABLED: process.env.OPPORTUNITY_ADAPTIVE_QUERY_PLAN_ENABLED,
    OPPORTUNITY_MAX_QUERY_JOBS: process.env.OPPORTUNITY_MAX_QUERY_JOBS,
    OPPORTUNITY_EMPTY_RESPONSE_BACKOFF_SEC: process.env.OPPORTUNITY_EMPTY_RESPONSE_BACKOFF_SEC,
    OPPORTUNITY_QUOTA_ERROR_BACKOFF_SEC: process.env.OPPORTUNITY_QUOTA_ERROR_BACKOFF_SEC,
    OPPORTUNITY_ENRICHMENT_ENABLED: process.env.OPPORTUNITY_ENRICHMENT_ENABLED,
    OPPORTUNITY_ENRICHMENT_MAX_ITEMS: process.env.OPPORTUNITY_ENRICHMENT_MAX_ITEMS,
    OPPORTUNITY_EXISTING_ENRICHMENT_MAX_ITEMS: process.env.OPPORTUNITY_EXISTING_ENRICHMENT_MAX_ITEMS,
    OPPORTUNITY_ENRICHMENT_RETRY_COOLDOWN_HOURS: process.env.OPPORTUNITY_ENRICHMENT_RETRY_COOLDOWN_HOURS,
    OPPORTUNITY_OFFICIAL_CRAWL_TIMEOUT_SEC: process.env.OPPORTUNITY_OFFICIAL_CRAWL_TIMEOUT_SEC,
    OPPORTUNITY_GROK_DEADLINE_FALLBACK_ENABLED: process.env.OPPORTUNITY_GROK_DEADLINE_FALLBACK_ENABLED,
    OPPORTUNITY_GROK_DEADLINE_FALLBACK_MAX: process.env.OPPORTUNITY_GROK_DEADLINE_FALLBACK_MAX
  };
  delete process.env.OPPORTUNITY_MONITOR_ENABLED;
  delete process.env.OPPORTUNITY_INTERVAL_SEC;
  delete process.env.OPPORTUNITY_SCHEDULE_MODE;
  delete process.env.OPPORTUNITY_COLLECTION_TYPES;
  delete process.env.OPPORTUNITY_DAILY_REPORT_ENABLED;
  delete process.env.OPPORTUNITY_DAILY_REPORT_TIME_BJ;
  delete process.env.OPPORTUNITY_LOOKBACK_HOURS;
  delete process.env.OPPORTUNITY_HERMES_PROFILE;
  delete process.env.OPPORTUNITY_HERMES_TIMEOUT_SEC;
  delete process.env.XINTEL_HERMES_MAX_CONCURRENCY;
  delete process.env.XINTEL_HERMES_MIN_INTERVAL_MS;
  delete process.env.OPPORTUNITY_STALE_AFTER_HOURS;
  delete process.env.OPPORTUNITY_MAX_FOLLOWUPS;
  delete process.env.OPPORTUNITY_FOCUSED_QUERIES_ENABLED;
  delete process.env.OPPORTUNITY_QUERY_MATRIX_ENABLED;
  delete process.env.OPPORTUNITY_ADAPTIVE_QUERY_PLAN_ENABLED;
  delete process.env.OPPORTUNITY_MAX_QUERY_JOBS;
  delete process.env.OPPORTUNITY_EMPTY_RESPONSE_BACKOFF_SEC;
  delete process.env.OPPORTUNITY_QUOTA_ERROR_BACKOFF_SEC;
  delete process.env.OPPORTUNITY_ENRICHMENT_ENABLED;
  delete process.env.OPPORTUNITY_ENRICHMENT_MAX_ITEMS;
  delete process.env.OPPORTUNITY_EXISTING_ENRICHMENT_MAX_ITEMS;
  delete process.env.OPPORTUNITY_ENRICHMENT_RETRY_COOLDOWN_HOURS;
  delete process.env.OPPORTUNITY_OFFICIAL_CRAWL_TIMEOUT_SEC;
  delete process.env.OPPORTUNITY_GROK_DEADLINE_FALLBACK_ENABLED;
  delete process.env.OPPORTUNITY_GROK_DEADLINE_FALLBACK_MAX;

  try {
    const { config } = await import(`../src/config.js?opportunity-defaults=${Date.now()}`);
    assert.equal(config.opportunityMonitorEnabled, true);
    assert.equal(config.opportunityIntervalSec, 86400);
    assert.equal(config.opportunityScheduleMode, "daily_report");
    assert.deepEqual(config.opportunityCollectionTypes, ["launch", "pre_tge"]);
    assert.equal(config.opportunityDailyReportEnabled, true);
    assert.equal(config.opportunityDailyReportTimeBj, "19:04");
    assert.equal(config.opportunityHermesProfile, "xintel");
    assert.equal(config.opportunityHermesTimeoutSec, 240);
    assert.equal(config.opportunityLookbackHours, 24);
    assert.equal(config.xintelHermesMaxConcurrency, 1);
    assert.equal(config.xintelHermesMinIntervalMs, 5000);
    assert.equal(config.opportunityStaleAfterHours, 1440);
    assert.equal(config.opportunityMaxFollowups, 1);
    assert.equal(config.opportunityFocusedQueriesEnabled, false);
    assert.equal(config.opportunityQueryMatrixEnabled, true);
    assert.equal(config.opportunityAdaptiveQueryPlanEnabled, true);
    assert.equal(config.opportunityMaxQueryJobs, 3);
    assert.equal(config.opportunityEmptyResponseBackoffSec, 3600);
    assert.equal(config.opportunityQuotaErrorBackoffSec, 43200);
    assert.equal(config.opportunityEnrichmentEnabled, true);
    assert.equal(config.opportunityEnrichmentMaxItems, 5);
    assert.equal(config.opportunityExistingEnrichmentMaxItems, 2);
    assert.equal(config.opportunityEnrichmentRetryCooldownHours, 12);
    assert.equal(config.opportunityOfficialCrawlTimeoutSec, 15);
    assert.equal(config.opportunityGrokDeadlineFallbackEnabled, true);
    assert.equal(config.opportunityGrokDeadlineFallbackMax, 1);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("config exposes daily report Telegram routing defaults", async () => {
  const original = {
    DAILY_REPORT_TIME_BJ: process.env.DAILY_REPORT_TIME_BJ,
    DAILY_REPORT_CHAT_ID: process.env.DAILY_REPORT_CHAT_ID
  };
  delete process.env.DAILY_REPORT_TIME_BJ;
  delete process.env.DAILY_REPORT_CHAT_ID;

  try {
    const { config } = await import(`../src/config.js?daily-report-defaults=${Date.now()}`);
    assert.equal(config.dailyReportTimeBj, "19:04");
    assert.equal(config.dailyReportChatId, "-5535517204");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("config exposes security incident monitor defaults", async () => {
  const original = {
    SECURITY_INCIDENT_MONITOR_ENABLED: process.env.SECURITY_INCIDENT_MONITOR_ENABLED,
    SECURITY_INCIDENT_INTERVAL_SEC: process.env.SECURITY_INCIDENT_INTERVAL_SEC,
    SECURITY_INCIDENT_LARGE_USD: process.env.SECURITY_INCIDENT_LARGE_USD,
    SECURITY_INCIDENT_CRITICAL_CHAT_ID: process.env.SECURITY_INCIDENT_CRITICAL_CHAT_ID,
    SECURITY_INCIDENT_ANOMALY_CHAT_ID: process.env.SECURITY_INCIDENT_ANOMALY_CHAT_ID
  };
  delete process.env.SECURITY_INCIDENT_MONITOR_ENABLED;
  delete process.env.SECURITY_INCIDENT_INTERVAL_SEC;
  delete process.env.SECURITY_INCIDENT_LARGE_USD;
  delete process.env.SECURITY_INCIDENT_CRITICAL_CHAT_ID;
  delete process.env.SECURITY_INCIDENT_ANOMALY_CHAT_ID;

  try {
    const { config } = await import(`../src/config.js?security-incident-defaults=${Date.now()}`);
    assert.equal(config.securityIncidentMonitorEnabled, true);
    assert.equal(config.securityIncidentIntervalSec, 1200);
    assert.equal(config.securityIncidentLargeUsd, 5000000);
    assert.equal(config.securityIncidentCriticalChatId, "-5519280405");
    assert.equal(config.securityIncidentAnomalyChatId, "-5363003109");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
