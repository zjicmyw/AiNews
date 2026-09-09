import Database from "better-sqlite3";
import crypto from "node:crypto";
import { ensureDirForFile, nowSec, normalizeTitle } from "./utils.js";

function safeParseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export class DbClient {
  constructor(dbPath) {
    ensureDirForFile(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        dedup_key TEXT NOT NULL,
        source_event_id TEXT,
        source_type TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        raw_text TEXT,
        publish_time TEXT,
        ingest_time TEXT NOT NULL,
        llm_invalid INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scores (
        event_id TEXT PRIMARY KEY,
        risk_score REAL NOT NULL,
        level INTEGER NOT NULL,
        regime TEXT NOT NULL,
        regime_probability REAL NOT NULL,
        market_confirmation REAL NOT NULL,
        news_severity REAL NOT NULL,
        asset_relevance REAL NOT NULL,
        source_credibility REAL NOT NULL,
        is_data_anomaly INTEGER NOT NULL,
        decision_reasons TEXT,
        analyzed_at TEXT NOT NULL,
        FOREIGN KEY(event_id) REFERENCES events(event_id)
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        btc_change_1h REAL,
        equities_change_1h REAL,
        gold_change_1h REAL,
        dxy_change_1h REAL,
        confirmation_score REAL NOT NULL,
        is_data_anomaly INTEGER NOT NULL,
        anomaly_reasons TEXT,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS push_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        dedup_key TEXT,
        level INTEGER,
        push_flag INTEGER NOT NULL,
        push_reason TEXT NOT NULL,
        latency_publish_to_push_sec INTEGER,
        payload TEXT,
        pushed_at TEXT NOT NULL,
        FOREIGN KEY(event_id) REFERENCES events(event_id)
      );

      CREATE TABLE IF NOT EXISTS system_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        module TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT
      );

      CREATE TABLE IF NOT EXISTS x_user_cache (
        username TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS x_since_cache (
        user_id TEXT PRIMARY KEY,
        since_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_reports (
        report_date TEXT PRIMARY KEY,
        timezone TEXT NOT NULL,
        scheduled_time TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        payload TEXT
      );

      CREATE TABLE IF NOT EXISTS notification_delivery (
        business_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        message_id TEXT,
        accepted_at TEXT,
        completed_at TEXT,
        checked_at TEXT,
        created_at TEXT NOT NULL,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notification_delivery_status ON notification_delivery(status, checked_at);
      CREATE INDEX IF NOT EXISTS idx_notification_delivery_group ON notification_delivery(group_id);
      CREATE INDEX IF NOT EXISTS idx_notification_delivery_created ON notification_delivery(created_at);
      CREATE TABLE IF NOT EXISTS notification_batches (
        group_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        report_date TEXT NOT NULL,
        due_at TEXT NOT NULL,
        expected_parts INTEGER NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opportunity_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        prompt TEXT,
        raw_response TEXT,
        error TEXT,
        item_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS binance_major_news_runs (
        report_date TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        universe_count INTEGER DEFAULT 0,
        findings_json TEXT,
        diagnostics_json TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedup_key TEXT NOT NULL UNIQUE,
        activity_name TEXT NOT NULL,
        type TEXT NOT NULL,
        section TEXT NOT NULL,
        exchange TEXT,
        venue TEXT,
        asset TEXT,
        stablecoin TEXT,
        apy REAL,
        expected_yield TEXT,
        reward TEXT,
        duration TEXT,
        deadline_at TEXT,
        source_published_at TEXT,
        participation TEXT,
        source_user TEXT,
        source_url TEXT,
        credibility TEXT,
        risk_note TEXT,
        status TEXT NOT NULL,
        raw_json TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS security_incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedup_key TEXT NOT NULL UNIQUE,
        project TEXT NOT NULL,
        incident_type TEXT NOT NULL,
        amount_usd REAL,
        chain_platform TEXT,
        source_url TEXT,
        source_user TEXT,
        source_type TEXT,
        source_published_at TEXT,
        confidence TEXT,
        evidence_score REAL,
        evidence_level TEXT,
        summary TEXT,
        alert_level TEXT NOT NULL,
        anomaly_pushed_at TEXT,
        critical_pushed_at TEXT,
        raw_json TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_ingest_time ON events(ingest_time);
      CREATE INDEX IF NOT EXISTS idx_push_logs_pushed_at ON push_logs(pushed_at);
      CREATE INDEX IF NOT EXISTS idx_push_logs_dedup_key ON push_logs(dedup_key);
      CREATE INDEX IF NOT EXISTS idx_x_user_cache_updated_at ON x_user_cache(updated_at);
      CREATE INDEX IF NOT EXISTS idx_x_since_cache_updated_at ON x_since_cache(updated_at);
      CREATE INDEX IF NOT EXISTS idx_opportunity_runs_started_at ON opportunity_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_binance_major_news_runs_finished_at ON binance_major_news_runs(finished_at);
      CREATE INDEX IF NOT EXISTS idx_opportunities_status_last_seen ON opportunities(status, last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_opportunities_section_type ON opportunities(section, type);
      CREATE INDEX IF NOT EXISTS idx_security_incidents_last_seen ON security_incidents(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_security_incidents_alert_level ON security_incidents(alert_level);
    `);

    ensureColumn(this.db, "notification_batches", "payload_json", "TEXT");
    ensureColumn(this.db, "opportunities", "official_url", "TEXT");
    ensureColumn(this.db, "opportunities", "official_url_source", "TEXT");
    ensureColumn(this.db, "opportunities", "deadline_source", "TEXT");
    ensureColumn(this.db, "opportunities", "deadline_confidence", "REAL");
    ensureColumn(this.db, "opportunities", "deadline_text", "TEXT");
    ensureColumn(this.db, "opportunities", "enriched_at", "TEXT");
    ensureColumn(this.db, "opportunities", "enrichment_error", "TEXT");
    ensureColumn(this.db, "opportunity_runs", "job_stats", "TEXT");
    ensureColumn(this.db, "security_incidents", "anomaly_pushed_at", "TEXT");
    ensureColumn(this.db, "security_incidents", "critical_pushed_at", "TEXT");
    ensureColumn(this.db, "security_incidents", "source_user", "TEXT");
    ensureColumn(this.db, "security_incidents", "source_type", "TEXT");
    ensureColumn(this.db, "security_incidents", "evidence_score", "REAL");
    ensureColumn(this.db, "security_incidents", "evidence_level", "TEXT");

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_opportunities_deadline_source ON opportunities(deadline_source);
    `);
    this.db
      .prepare(
        `UPDATE opportunities
         SET official_url_source = 'official_page'
         WHERE official_url IS NOT NULL AND official_url_source IS NULL`
      )
      .run();
    this.db
      .prepare(
        `UPDATE opportunities
         SET deadline_source = 'xintel',
             deadline_confidence = COALESCE(deadline_confidence, 0.55),
             deadline_text = COALESCE(deadline_text, duration)
         WHERE deadline_at IS NOT NULL AND deadline_source IS NULL`
      )
      .run();
    this.db
      .prepare(
        `UPDATE opportunities
         SET deadline_confidence = deadline_confidence / 100.0
         WHERE deadline_confidence > 1`
      )
      .run();
    this.db
      .prepare(
        `UPDATE opportunities
         SET deadline_source = NULL,
             deadline_confidence = NULL
         WHERE deadline_at IS NULL
           AND (deadline_source IS NULL OR deadline_source != 'no_fixed_deadline')`
      )
      .run();
    this.db
      .prepare(
        `UPDATE opportunities
         SET deadline_source = 'no_fixed_deadline',
             deadline_confidence = COALESCE(deadline_confidence, 0.55),
             deadline_text = COALESCE(deadline_text, '无固定截止')
         WHERE deadline_at IS NULL
           AND (
             lower(COALESCE(deadline_text, '')) LIKE '%ongoing%'
             OR lower(COALESCE(deadline_text, '')) LIKE '%no fixed%'
             OR lower(COALESCE(deadline_text, '')) LIKE '%monthly%'
             OR COALESCE(deadline_text, '') LIKE '%持续中%'
             OR COALESCE(deadline_text, '') LIKE '%无固定截止%'
             OR COALESCE(deadline_text, '') LIKE '%未注明固定截止%'
             OR COALESCE(duration, '') LIKE '%持续%'
             OR lower(COALESCE(duration, '')) LIKE '%monthly%'
             OR lower(COALESCE(risk_note, '')) LIKE '%no fixed end date%'
             OR COALESCE(risk_note, '') LIKE '%未注明固定截止%'
           )`
      )
      .run();
  }

  close() {
    this.db.close();
  }

  buildEventId(event) {
    const raw = [event.source_type, event.source, event.title, event.publish_time, event.url].join("|");
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  buildDedupKey(event) {
    const normalized = normalizeTitle(event.title);
    return crypto.createHash("sha256").update(normalized).digest("hex");
  }

  insertEventIfNew(event) {
    const eventId = this.buildEventId(event);
    const dedupKey = this.buildDedupKey(event);
    const ingestTime = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        event_id, dedup_key, source_event_id, source_type, source, title, url, raw_text, publish_time, ingest_time, created_at
      ) VALUES (
        @event_id, @dedup_key, @source_event_id, @source_type, @source, @title, @url, @raw_text, @publish_time, @ingest_time, @created_at
      )
    `);
    const result = stmt.run({
      event_id: eventId,
      dedup_key: dedupKey,
      source_event_id: event.id || null,
      source_type: event.source_type,
      source: event.source,
      title: event.title,
      url: event.url || null,
      raw_text: event.raw_text || null,
      publish_time: event.publish_time || event.timestamp || null,
      ingest_time: ingestTime,
      created_at: ingestTime
    });
    return { inserted: result.changes === 1, eventId, dedupKey, ingestTime };
  }

  markEventLlmInvalid(eventId) {
    this.db.prepare("UPDATE events SET llm_invalid = 1 WHERE event_id = ?").run(eventId);
  }

  saveScore(row) {
    this.db
      .prepare(`
      INSERT INTO scores (
        event_id, risk_score, level, regime, regime_probability, market_confirmation,
        news_severity, asset_relevance, source_credibility, is_data_anomaly,
        decision_reasons, analyzed_at
      ) VALUES (
        @event_id, @risk_score, @level, @regime, @regime_probability, @market_confirmation,
        @news_severity, @asset_relevance, @source_credibility, @is_data_anomaly,
        @decision_reasons, @analyzed_at
      )
      ON CONFLICT(event_id) DO UPDATE SET
        risk_score=excluded.risk_score,
        level=excluded.level,
        regime=excluded.regime,
        regime_probability=excluded.regime_probability,
        market_confirmation=excluded.market_confirmation,
        news_severity=excluded.news_severity,
        asset_relevance=excluded.asset_relevance,
        source_credibility=excluded.source_credibility,
        is_data_anomaly=excluded.is_data_anomaly,
        decision_reasons=excluded.decision_reasons,
        analyzed_at=excluded.analyzed_at
    `)
      .run({
        ...row,
        is_data_anomaly: row.is_data_anomaly ? 1 : 0,
        decision_reasons: JSON.stringify(row.decision_reasons || []),
        analyzed_at: row.analyzed_at || new Date().toISOString()
      });
  }

  saveMarketSnapshot(snapshot) {
    this.db
      .prepare(`
      INSERT INTO market_snapshots (
        ts, btc_change_1h, equities_change_1h, gold_change_1h, dxy_change_1h,
        confirmation_score, is_data_anomaly, anomaly_reasons, raw_json
      ) VALUES (
        @ts, @btc_change_1h, @equities_change_1h, @gold_change_1h, @dxy_change_1h,
        @confirmation_score, @is_data_anomaly, @anomaly_reasons, @raw_json
      )
    `)
      .run({
        ts: new Date().toISOString(),
        btc_change_1h: snapshot.btc_change_1h,
        equities_change_1h: snapshot.equities_change_1h,
        gold_change_1h: snapshot.gold_change_1h,
        dxy_change_1h: snapshot.dxy_change_1h,
        confirmation_score: snapshot.confirmation_score,
        is_data_anomaly: snapshot.is_data_anomaly ? 1 : 0,
        anomaly_reasons: JSON.stringify(snapshot.anomaly_reasons || []),
        raw_json: JSON.stringify(snapshot.raw || {})
      });
  }

  insertPushLog(log) {
    this.db
      .prepare(`
      INSERT INTO push_logs (
        event_id, dedup_key, level, push_flag, push_reason,
        latency_publish_to_push_sec, payload, pushed_at
      ) VALUES (
        @event_id, @dedup_key, @level, @push_flag, @push_reason,
        @latency_publish_to_push_sec, @payload, @pushed_at
      )
    `)
      .run({
        event_id: log.event_id || null,
        dedup_key: log.dedup_key || null,
        level: log.level || null,
        push_flag: log.push_flag ? 1 : 0,
        push_reason: log.push_reason,
        latency_publish_to_push_sec: log.latency_publish_to_push_sec ?? null,
        payload: JSON.stringify(log.payload || {}),
        pushed_at: log.pushed_at || new Date().toISOString()
      });
  }

  canPushByDedup(dedupKey, windowMinutes) {
    const threshold = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT id FROM push_logs WHERE dedup_key = ? AND push_flag = 1 AND pushed_at >= ? ORDER BY id DESC LIMIT 1`
      )
      .get(dedupKey, threshold);
    return !row;
  }

  canPushLevel2ByCooldown(cooldownMinutes) {
    const threshold = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
    const row = this.db
      .prepare(`SELECT id FROM push_logs WHERE level = 2 AND push_flag = 1 AND pushed_at >= ? ORDER BY id DESC LIMIT 1`)
      .get(threshold);
    return !row;
  }

  canPushLevel3ByDailyLimit(limit) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM push_logs WHERE level = 3 AND push_flag = 1 AND pushed_at >= ?`
      )
      .get(start.toISOString());
    return Number(row?.cnt || 0) < limit;
  }

  getLastHighEvents(limit = 10) {
    return this.db
      .prepare(
        `
      SELECT e.event_id, e.title, e.source, e.url, e.publish_time, s.risk_score, s.level, s.regime
      FROM events e
      JOIN scores s ON s.event_id = e.event_id
      ORDER BY s.risk_score DESC, e.ingest_time DESC
      LIMIT ?
    `
      )
      .all(limit);
  }

  getLatestRegimeStatus() {
    const row = this.db
      .prepare(
        `
      SELECT s.regime, s.regime_probability, s.risk_score, s.market_confirmation
      FROM scores s
      ORDER BY s.analyzed_at DESC
      LIMIT 1
    `
      )
      .get();
    if (!row) {
      return {
        regime: "Neutral",
        regime_probability: 50,
        risk_score: 0,
        market_confirmation: 0
      };
    }
    return row;
  }

  recordHealth(module, status, detail = "") {
    this.db
      .prepare(`INSERT INTO system_health (ts, module, status, detail) VALUES (?, ?, ?, ?)`)
      .run(new Date().toISOString(), module, status, detail);
  }

  getRecentHealth(module, limit = 10) {
    return this.db
      .prepare(
        `SELECT ts, module, status, detail
         FROM system_health
         WHERE module = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(module, Math.max(1, Math.min(50, Number(limit || 10))));
  }

  getStats() {
    const events = this.db.prepare(`SELECT COUNT(*) AS cnt FROM events`).get();
    const pushes = this.db.prepare(`SELECT COUNT(*) AS cnt FROM push_logs WHERE push_flag = 1`).get();
    const activeOpportunities = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM opportunities WHERE status = 'active'`)
      .get();
    return {
      total_events: Number(events?.cnt || 0),
      total_pushes: Number(pushes?.cnt || 0),
      active_opportunities: Number(activeOpportunities?.cnt || 0),
      now_sec: nowSec()
    };
  }

  startOpportunityRun({ startedAt, prompt }) {
    const result = this.db
      .prepare(
        `INSERT INTO opportunity_runs (started_at, status, prompt, item_count)
         VALUES (?, 'running', ?, 0)`
      )
      .run(startedAt || new Date().toISOString(), prompt || "");
    return result.lastInsertRowid;
  }

  finishOpportunityRun(runId, { status, durationMs, rawResponse, error, itemCount, jobStats }) {
    if (!runId) return;
    this.db
      .prepare(
        `UPDATE opportunity_runs
         SET finished_at = ?, status = ?, duration_ms = ?, raw_response = ?, error = ?, item_count = ?, job_stats = ?
         WHERE id = ?`
      )
      .run(
        new Date().toISOString(),
        status || "ok",
        Number.isFinite(durationMs) ? durationMs : null,
        rawResponse || "",
        error || "",
        Number.isFinite(itemCount) ? itemCount : 0,
        Array.isArray(jobStats) ? JSON.stringify(jobStats) : null,
        runId
      );
  }

  upsertOpportunity(item) {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO opportunities (
          dedup_key, activity_name, type, section, exchange, venue, asset, stablecoin, apy,
          expected_yield, reward, duration, deadline_at, source_published_at, participation,
          source_user, source_url, credibility, risk_note, status, official_url,
          official_url_source, deadline_source, deadline_confidence, deadline_text, enriched_at, enrichment_error, raw_json,
          first_seen_at, last_seen_at, updated_at
        ) VALUES (
          @dedup_key, @activity_name, @type, @section, @exchange, @venue, @asset, @stablecoin, @apy,
          @expected_yield, @reward, @duration, @deadline_at, @source_published_at, @participation,
          @source_user, @source_url, @credibility, @risk_note, @status, @official_url,
          @official_url_source, @deadline_source, @deadline_confidence, @deadline_text, @enriched_at, @enrichment_error, @raw_json,
          @first_seen_at, @last_seen_at, @updated_at
        )
        ON CONFLICT(dedup_key) DO UPDATE SET
          activity_name=excluded.activity_name,
          type=excluded.type,
          section=excluded.section,
          exchange=excluded.exchange,
          venue=excluded.venue,
          asset=excluded.asset,
          stablecoin=excluded.stablecoin,
          apy=excluded.apy,
          expected_yield=excluded.expected_yield,
          reward=excluded.reward,
          duration=excluded.duration,
          deadline_at=COALESCE(excluded.deadline_at, opportunities.deadline_at),
          source_published_at=excluded.source_published_at,
          participation=excluded.participation,
          source_user=excluded.source_user,
          source_url=excluded.source_url,
          credibility=excluded.credibility,
          risk_note=excluded.risk_note,
          status=CASE
            WHEN excluded.status = 'unverified' AND opportunities.status = 'active' AND opportunities.deadline_at IS NOT NULL THEN opportunities.status
            ELSE excluded.status
          END,
          official_url=COALESCE(excluded.official_url, opportunities.official_url),
          official_url_source=COALESCE(excluded.official_url_source, opportunities.official_url_source),
          deadline_source=COALESCE(excluded.deadline_source, opportunities.deadline_source),
          deadline_confidence=COALESCE(excluded.deadline_confidence, opportunities.deadline_confidence),
          deadline_text=COALESCE(excluded.deadline_text, opportunities.deadline_text),
          enriched_at=COALESCE(excluded.enriched_at, opportunities.enriched_at),
          enrichment_error=excluded.enrichment_error,
          raw_json=excluded.raw_json,
          last_seen_at=excluded.last_seen_at,
          updated_at=excluded.updated_at`
      )
      .run({
        dedup_key: item.dedup_key,
        activity_name: item.activity_name,
        type: item.type,
        section: item.section,
        exchange: item.exchange || null,
        venue: item.venue || null,
        asset: item.asset || null,
        stablecoin: item.stablecoin || null,
        apy: Number.isFinite(item.apy) ? item.apy : null,
        expected_yield: item.expected_yield || null,
        reward: item.reward || null,
        duration: item.duration || null,
        deadline_at: item.deadline_at || null,
        source_published_at: item.source_published_at || null,
        participation: item.participation || null,
        source_user: item.source_user || null,
        source_url: item.source_url || null,
        credibility: item.credibility || "unverified",
        risk_note: item.risk_note || null,
        status: item.status || "unverified",
        official_url: item.official_url || null,
        official_url_source: item.official_url_source || null,
        deadline_source: item.deadline_source || null,
        deadline_confidence: Number.isFinite(item.deadline_confidence) ? item.deadline_confidence : null,
        deadline_text: item.deadline_text || null,
        enriched_at: item.enriched_at || null,
        enrichment_error: item.enrichment_error || null,
        raw_json: item.raw_json || JSON.stringify(item),
        first_seen_at: item.first_seen_at || nowIso,
        last_seen_at: nowIso,
        updated_at: nowIso
      });
  }

  getOpportunityDeadlineEnrichmentCandidates(
    limit = 5,
    retryCooldownHours = 12,
    nowIso = new Date().toISOString()
  ) {
    const cooldownHours = Math.max(0, Number(retryCooldownHours || 0));
    const retryBefore = new Date(Date.parse(nowIso) - cooldownHours * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(
        `SELECT *
         FROM opportunities
         WHERE status IN ('active', 'unverified')
           AND (deadline_at IS NULL OR deadline_source IS NULL OR official_url IS NULL)
           AND COALESCE(deadline_source, '') != 'no_fixed_deadline'
           AND (enriched_at IS NULL OR enriched_at < ?)
         ORDER BY
           CASE WHEN deadline_at IS NULL THEN 0 ELSE 1 END,
           CASE section WHEN 'cex' THEN 0 ELSE 1 END,
           CASE type
             WHEN 'stablecoin_earn' THEN 0
             WHEN 'pre_ipo' THEN 1
             WHEN 'launch' THEN 2
             WHEN 'onchain' THEN 3
             ELSE 4
           END,
           COALESCE(apy, 0) DESC,
           last_seen_at DESC
         LIMIT ?`
      )
      .all(retryBefore, Math.max(1, Number(limit || 5)))
      .map((row) => ({
        ...row,
        apy: row.apy === null || row.apy === undefined ? null : Number(row.apy),
        deadline_confidence:
          row.deadline_confidence === null || row.deadline_confidence === undefined
            ? null
            : Number(row.deadline_confidence)
      }));
  }

  markExpiredOpportunities(nowIso = new Date().toISOString()) {
    this.db
      .prepare(
        `UPDATE opportunities
         SET status = 'expired', updated_at = ?
         WHERE status != 'expired' AND deadline_at IS NOT NULL AND deadline_at < ?`
      )
      .run(nowIso, nowIso);
  }

  getSecurityIncidentByDedup(dedupKey) {
    return this.db.prepare(`SELECT * FROM security_incidents WHERE dedup_key = ?`).get(dedupKey);
  }

  upsertSecurityIncident(item) {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO security_incidents (
          dedup_key, project, incident_type, amount_usd, chain_platform, source_url, source_user,
          source_type, source_published_at, confidence, evidence_score, evidence_level, summary, alert_level, anomaly_pushed_at,
          critical_pushed_at, raw_json, first_seen_at, last_seen_at, updated_at
        ) VALUES (
          @dedup_key, @project, @incident_type, @amount_usd, @chain_platform, @source_url, @source_user,
          @source_type, @source_published_at, @confidence, @evidence_score, @evidence_level, @summary, @alert_level, @anomaly_pushed_at,
          @critical_pushed_at, @raw_json, @first_seen_at, @last_seen_at, @updated_at
        )
        ON CONFLICT(dedup_key) DO UPDATE SET
          project=excluded.project,
          incident_type=excluded.incident_type,
          amount_usd=CASE
            WHEN excluded.amount_usd IS NULL THEN security_incidents.amount_usd
            WHEN security_incidents.amount_usd IS NULL THEN excluded.amount_usd
            WHEN excluded.amount_usd > security_incidents.amount_usd THEN excluded.amount_usd
            ELSE security_incidents.amount_usd
          END,
          chain_platform=COALESCE(excluded.chain_platform, security_incidents.chain_platform),
          source_url=COALESCE(excluded.source_url, security_incidents.source_url),
          source_user=COALESCE(excluded.source_user, security_incidents.source_user),
          source_type=CASE
            WHEN security_incidents.source_type IN ('official', 'security_researcher') THEN security_incidents.source_type
            WHEN excluded.source_type IN ('official', 'security_researcher') THEN excluded.source_type
            WHEN security_incidents.source_type = 'media' THEN security_incidents.source_type
            WHEN excluded.source_type = 'media' THEN excluded.source_type
            WHEN security_incidents.source_type = 'kol' THEN security_incidents.source_type
            WHEN excluded.source_type = 'kol' THEN excluded.source_type
            ELSE COALESCE(excluded.source_type, security_incidents.source_type)
          END,
          source_published_at=COALESCE(excluded.source_published_at, security_incidents.source_published_at),
          confidence=excluded.confidence,
          evidence_score=CASE
            WHEN excluded.evidence_score IS NULL THEN security_incidents.evidence_score
            WHEN security_incidents.evidence_score IS NULL THEN excluded.evidence_score
            WHEN excluded.evidence_score > security_incidents.evidence_score THEN excluded.evidence_score
            ELSE security_incidents.evidence_score
          END,
          evidence_level=CASE
            WHEN excluded.evidence_level = 'high' OR security_incidents.evidence_level = 'high' THEN 'high'
            WHEN excluded.evidence_level = 'medium' OR security_incidents.evidence_level = 'medium' THEN 'medium'
            ELSE COALESCE(excluded.evidence_level, security_incidents.evidence_level)
          END,
          summary=excluded.summary,
          alert_level=CASE
            WHEN excluded.alert_level = 'critical' OR security_incidents.alert_level = 'critical' THEN 'critical'
            WHEN excluded.alert_level = 'anomaly' OR security_incidents.alert_level = 'anomaly' THEN 'anomaly'
            ELSE COALESCE(excluded.alert_level, security_incidents.alert_level)
          END,
          raw_json=excluded.raw_json,
          last_seen_at=excluded.last_seen_at,
          updated_at=excluded.updated_at`
      )
      .run({
        dedup_key: item.dedup_key,
        project: item.project,
        incident_type: item.incident_type,
        amount_usd: Number.isFinite(item.amount_usd) ? item.amount_usd : null,
        chain_platform: item.chain_platform || null,
        source_url: item.source_url || null,
        source_user: item.source_user || null,
        source_type: item.source_type || "unknown",
        source_published_at: item.source_published_at || null,
        confidence: item.confidence || "medium",
        evidence_score: Number.isFinite(item.evidence_score) ? item.evidence_score : null,
        evidence_level: item.evidence_level || null,
        summary: item.summary || "",
        alert_level: item.alert_level || "anomaly",
        anomaly_pushed_at: item.anomaly_pushed_at || null,
        critical_pushed_at: item.critical_pushed_at || null,
        raw_json: item.raw_json || JSON.stringify(item),
        first_seen_at: item.first_seen_at || nowIso,
        last_seen_at: nowIso,
        updated_at: nowIso
      });
    return this.getSecurityIncidentByDedup(item.dedup_key);
  }

  markSecurityIncidentPushed(dedupKey, alertLevel, pushedAt = new Date().toISOString()) {
    const column = alertLevel === "critical" ? "critical_pushed_at" : "anomaly_pushed_at";
    this.db.prepare(`UPDATE security_incidents SET ${column} = ?, updated_at = ? WHERE dedup_key = ?`).run(
      pushedAt,
      pushedAt,
      dedupKey
    );
  }

  getSecurityIncidents(limit = 20) {
    return this.db
      .prepare(
        `SELECT *
         FROM security_incidents
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(100, Number(limit || 20))))
      .map((row) => ({
        ...row,
        amount_usd: row.amount_usd === null || row.amount_usd === undefined ? null : Number(row.amount_usd),
        evidence_score: row.evidence_score === null || row.evidence_score === undefined ? null : Number(row.evidence_score)
      }));
  }

  getSecurityIncidentSummary() {
    const total = this.db.prepare(`SELECT COUNT(*) AS cnt FROM security_incidents`).get();
    const critical = this.db.prepare(`SELECT COUNT(*) AS cnt FROM security_incidents WHERE alert_level = 'critical'`).get();
    const anomaly = this.db.prepare(`SELECT COUNT(*) AS cnt FROM security_incidents WHERE alert_level = 'anomaly'`).get();
    const watch = this.db.prepare(`SELECT COUNT(*) AS cnt FROM security_incidents WHERE alert_level = 'watch'`).get();
    const pushed = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM security_incidents
         WHERE anomaly_pushed_at IS NOT NULL OR critical_pushed_at IS NOT NULL`
      )
      .get();
    return {
      total: Number(total?.cnt || 0),
      critical: Number(critical?.cnt || 0),
      anomaly: Number(anomaly?.cnt || 0),
      watch: Number(watch?.cnt || 0),
      pushed: Number(pushed?.cnt || 0)
    };
  }

  getActiveOpportunities(staleAfterHours = 1440, nowIso = new Date().toISOString()) {
    return this.getDisplayOpportunities(staleAfterHours, nowIso).filter((row) => row.status === "active");
  }

  getDisplayOpportunities(staleAfterHours = 1440, nowIso = new Date().toISOString()) {
    const staleHours = Math.max(1, Number(staleAfterHours || 1440));
    const staleThreshold = new Date(Date.parse(nowIso) - staleHours * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(
        `SELECT *
         FROM opportunities
         WHERE status IN ('active', 'unverified')
           AND (
             (deadline_at IS NOT NULL AND deadline_at >= ?)
             OR (deadline_at IS NULL AND last_seen_at >= ?)
           )
         ORDER BY
           CASE WHEN deadline_at IS NOT NULL AND deadline_at >= ? THEN 0 ELSE 1 END,
           CASE status WHEN 'active' THEN 0 ELSE 1 END,
           CASE section WHEN 'cex' THEN 0 ELSE 1 END,
           CASE type
             WHEN 'stablecoin_earn' THEN 0
             WHEN 'pre_ipo' THEN 1
             WHEN 'launch' THEN 2
             WHEN 'short_term' THEN 3
             ELSE 4
           END,
           CASE WHEN deadline_at IS NULL THEN 1 ELSE 0 END,
           deadline_at ASC,
           COALESCE(apy, 0) DESC,
           last_seen_at DESC
         LIMIT 200`
      )
      .all(nowIso, staleThreshold, nowIso)
      .map((row) => ({
        ...row,
        apy: row.apy === null || row.apy === undefined ? null : Number(row.apy)
      }));
  }

  hasOpportunityRunSince(startIso, endIso = new Date().toISOString()) {
    if (!startIso || !endIso) return false;
    const row = this.db
      .prepare(
        `SELECT id
         FROM opportunity_runs
         WHERE started_at >= ? AND started_at < ?
           AND status IN ('ok', 'partial')
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(startIso, endIso);
    return Boolean(row?.id);
  }

  getOpportunitiesSeenSince(startIso, endIso = new Date().toISOString(), types = [], limit = 8) {
    const selectedTypes = Array.isArray(types) ? types.map((type) => String(type || "").trim()).filter(Boolean) : [];
    if (!startIso || !endIso || selectedTypes.length === 0) return [];
    const placeholders = selectedTypes.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT *
         FROM opportunities
         WHERE last_seen_at >= ? AND last_seen_at < ?
           AND status IN ('active', 'unverified')
           AND type IN (${placeholders})
         ORDER BY
           CASE type WHEN 'launch' THEN 0 WHEN 'pre_tge' THEN 1 ELSE 2 END,
           CASE status WHEN 'active' THEN 0 ELSE 1 END,
           CASE WHEN deadline_at IS NULL THEN 1 ELSE 0 END,
           deadline_at ASC,
           last_seen_at DESC
         LIMIT ?`
      )
      .all(startIso, endIso, ...selectedTypes, Math.max(1, Math.min(30, Number(limit || 8))))
      .map((row) => ({
        ...row,
        apy: row.apy === null || row.apy === undefined ? null : Number(row.apy)
      }));
  }

  getLatestOpportunityRun() {
    const row = this.db
      .prepare(
        `SELECT id, started_at, finished_at, status, duration_ms, error, item_count, job_stats
         FROM opportunity_runs
         ORDER BY id DESC
         LIMIT 1`
      )
      .get();
    if (!row) return null;
    return { ...row, job_stats: safeParseJson(row.job_stats || "[]", []) };
  }

  getOpportunityRuns(limit = 10) {
    return this.db
      .prepare(
        `SELECT id, started_at, finished_at, status, duration_ms, error, item_count, job_stats
         FROM opportunity_runs
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(50, Number(limit || 10))))
      .map((row) => ({ ...row, job_stats: safeParseJson(row.job_stats || "[]", []) }));
  }

  getCachedXUserId(username) {
    if (!username) return null;
    const row = this.db.prepare(`SELECT user_id FROM x_user_cache WHERE username = ?`).get(username.toLowerCase());
    return row?.user_id || null;
  }

  saveXUserId(username, userId) {
    if (!username || !userId) return;
    this.db
      .prepare(
        `INSERT INTO x_user_cache (username, user_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET user_id=excluded.user_id, updated_at=excluded.updated_at`
      )
      .run(username.toLowerCase(), userId, new Date().toISOString());
  }

  getCachedXSinceId(userId) {
    if (!userId) return null;
    const row = this.db.prepare(`SELECT since_id FROM x_since_cache WHERE user_id = ?`).get(userId);
    return row?.since_id || null;
  }

  saveXSinceId(userId, sinceId) {
    if (!userId || !sinceId) return;
    this.db
      .prepare(
        `INSERT INTO x_since_cache (user_id, since_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET since_id=excluded.since_id, updated_at=excluded.updated_at`
      )
      .run(userId, sinceId, new Date().toISOString());
  }

  getNotificationDelivery(businessId) {
    return this.db.prepare("SELECT * FROM notification_delivery WHERE business_id=?").get(businessId) || null;
  }

  claimNotificationDelivery(row) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO notification_delivery
      (business_id, group_id, kind, mode, idempotency_key, payload_hash, status, created_at, reason)
      VALUES (@business_id, @group_id, @kind, @mode, @idempotency_key, @payload_hash, 'unknown', @created_at, 'submission_intent')`).run(row);
    if (result.changes === 1) return true;
    // A configuration failure has no submission intent and is safe to submit once repaired.
    return this.db.prepare(`UPDATE notification_delivery SET status='unknown', reason='submission_intent',
      mode=@mode, idempotency_key=@idempotency_key, payload_hash=@payload_hash,
      created_at=@created_at, checked_at=NULL
      WHERE business_id=@business_id AND status='failed' AND reason='configuration_missing'`).run(row).changes === 1;
  }

  recordNotificationPreflight(row) {
    this.db.prepare(`INSERT OR IGNORE INTO notification_delivery
      (business_id,group_id,kind,mode,idempotency_key,payload_hash,status,created_at,reason)
      VALUES (@business_id,@group_id,@kind,@mode,@idempotency_key,@payload_hash,'failed',@created_at,'configuration_missing')`).run(row);
  }

  updateNotificationDelivery(businessId, result) {
    this.db.prepare(`UPDATE notification_delivery SET status=@status,
      task_id=COALESCE(@task_id,task_id), message_id=COALESCE(@message_id,message_id),
      accepted_at=COALESCE(accepted_at,@accepted_at), completed_at=COALESCE(@completed_at,completed_at),
      checked_at=@checked_at, reason=@reason WHERE business_id=@business_id AND status NOT IN ('sent','suppressed')`).run({
      business_id: businessId, status: result.status, task_id: result.taskId || null,
      message_id: result.messageId ? String(result.messageId) : null,
      accepted_at: result.acceptedAt || null, completed_at: result.completedAt || null,
      checked_at: new Date().toISOString(), reason: result.reason || null
    });
  }

  getNotificationReconciliation(limit = 20) {
    return this.db.prepare(`SELECT * FROM notification_delivery
      WHERE mode='relay' AND status IN ('queued','unknown') AND created_at >= ?
      AND (checked_at IS NULL OR checked_at < ?) ORDER BY COALESCE(checked_at,created_at) LIMIT ?`)
      .all(new Date(Date.now() - 2 * 86400000).toISOString(), new Date(Date.now() - 30000).toISOString(), Math.min(20, Math.max(1, limit)));
  }

  claimNotificationBatch({ groupId, kind, reportDate, scheduledTime, expectedParts, messages, chatId, payload }) {
    const dueAt = new Date(`${reportDate}T${scheduledTime}:00+08:00`).toISOString();
    return this.db.prepare(`INSERT OR IGNORE INTO notification_batches
      (group_id,kind,report_date,due_at,expected_parts,payload_json,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(groupId, kind, reportDate, dueAt, expectedParts, messages ? JSON.stringify({ messages, chatId, payload, scheduledTime }) : null, new Date().toISOString()).changes === 1;
  }

  getNotificationBatch(groupId) {
    return this.db.prepare("SELECT * FROM notification_batches WHERE group_id=?").get(groupId) || null;
  }

  getNotificationBatchesToResume() {
    return this.db.prepare(`SELECT * FROM notification_batches b WHERE created_at >= ? AND payload_json IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM daily_reports d WHERE d.report_date=b.group_id)
      ORDER BY created_at LIMIT 5`).all(new Date(Date.now() - 2 * 86400000).toISOString());
  }

  getBusinessDeliveryEvidence(reportIds, since) {
    const placeholders = reportIds.map(() => '?').join(',');
    return {
      batches: this.db.prepare(`SELECT * FROM notification_batches WHERE group_id IN (${placeholders})`).all(...reportIds),
      reports: this.db.prepare(`SELECT report_date, scheduled_time, sent_at FROM daily_reports WHERE report_date IN (${placeholders})`).all(...reportIds),
      legacy_event_unverified_count: this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM push_logs p WHERE p.push_flag=1 AND p.pushed_at >= ?
          AND NOT EXISTS (SELECT 1 FROM notification_delivery n WHERE n.business_id='risk:' || p.event_id))
        + (SELECT COUNT(*) FROM security_incidents s WHERE s.anomaly_pushed_at >= ?
          AND NOT EXISTS (SELECT 1 FROM notification_delivery n WHERE n.business_id='security:' || s.dedup_key || ':anomaly'))
        + (SELECT COUNT(*) FROM security_incidents s WHERE s.critical_pushed_at >= ?
          AND NOT EXISTS (SELECT 1 FROM notification_delivery n WHERE n.business_id='security:' || s.dedup_key || ':critical')) AS n`)
        .get(since, since, since).n,
      receipts: this.db.prepare(`SELECT * FROM notification_delivery WHERE group_id IN (${placeholders})
        OR created_at >= ? ORDER BY created_at DESC LIMIT 501`).all(...reportIds, since)
    };
  }

  hasDailyReportSent(reportDate) {
    if (!reportDate) return false;
    const row = this.db.prepare(`SELECT report_date FROM daily_reports WHERE report_date = ? LIMIT 1`).get(reportDate);
    return Boolean(row?.report_date);
  }

  getBinanceMajorNewsRun(reportDate) {
    if (!reportDate) return null;
    const row = this.db.prepare(`SELECT * FROM binance_major_news_runs WHERE report_date = ?`).get(reportDate);
    if (!row) return null;
    return {
      ...row,
      findings: safeParseJson(row.findings_json || "[]", []),
      diagnostics: safeParseJson(row.diagnostics_json || "[]", [])
    };
  }

  startBinanceMajorNewsRun(reportDate) {
    if (!reportDate) return;
    this.db
      .prepare(
        `INSERT INTO binance_major_news_runs (report_date, started_at, status)
         VALUES (?, ?, 'running')
         ON CONFLICT(report_date) DO UPDATE SET
           started_at=excluded.started_at,
           finished_at=NULL,
           status='running',
           error=NULL`
      )
      .run(reportDate, new Date().toISOString());
  }

  finishBinanceMajorNewsRun(reportDate, result = {}) {
    if (!reportDate) return;
    this.db
      .prepare(
        `UPDATE binance_major_news_runs
         SET finished_at=?, status=?, universe_count=?, findings_json=?, diagnostics_json=?, error=?
         WHERE report_date=?`
      )
      .run(
        new Date().toISOString(),
        result.status || "ok",
        Number(result.universeCount || 0),
        JSON.stringify(result.items || []),
        JSON.stringify(result.diagnostics || []),
        result.error || "",
        reportDate
      );
  }

  saveDailyReport({ reportDate, timezone, scheduledTime, payload }) {
    if (!reportDate) return;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO daily_reports (report_date, timezone, scheduled_time, sent_at, payload)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        reportDate,
        timezone || "Asia/Shanghai",
        scheduledTime || "16:43",
        new Date().toISOString(),
        JSON.stringify(payload || {})
      );
  }

  getDailyReportSummary(startIso, endIso) {
    const stats = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM events WHERE ingest_time >= ? AND ingest_time < ?) AS total_events,
           (SELECT COUNT(*) FROM scores WHERE analyzed_at >= ? AND analyzed_at < ?) AS scored_events,
           (SELECT COUNT(*) FROM push_logs WHERE push_flag = 1 AND pushed_at >= ? AND pushed_at < ?) AS pushed_ok
        `
      )
      .get(startIso, endIso, startIso, endIso, startIso, endIso);

    const bins = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN risk_score >= 0 AND risk_score < 20 THEN 1 ELSE 0 END) AS b0_20,
           SUM(CASE WHEN risk_score >= 20 AND risk_score < 40 THEN 1 ELSE 0 END) AS b20_40,
           SUM(CASE WHEN risk_score >= 40 AND risk_score < 50 THEN 1 ELSE 0 END) AS b40_50,
           SUM(CASE WHEN risk_score >= 50 AND risk_score < 60 THEN 1 ELSE 0 END) AS b50_60,
           SUM(CASE WHEN risk_score >= 60 AND risk_score < 70 THEN 1 ELSE 0 END) AS b60_70,
           SUM(CASE WHEN risk_score >= 70 AND risk_score < 80 THEN 1 ELSE 0 END) AS b70_80,
           SUM(CASE WHEN risk_score >= 80 AND risk_score <= 100 THEN 1 ELSE 0 END) AS b80_100
         FROM scores
         WHERE analyzed_at >= ? AND analyzed_at < ?`
      )
      .get(startIso, endIso);

    const sources = this.db
      .prepare(
        `SELECT source_type, COUNT(*) AS cnt
         FROM events
         WHERE ingest_time >= ? AND ingest_time < ?
         GROUP BY source_type
         ORDER BY cnt DESC`
      )
      .all(startIso, endIso);

    const blockedReasons = this.db
      .prepare(
        `SELECT push_reason, COUNT(*) AS cnt
         FROM push_logs
         WHERE push_flag = 0 AND pushed_at >= ? AND pushed_at < ?
         GROUP BY push_reason
         ORDER BY cnt DESC
         LIMIT 3`
      )
      .all(startIso, endIso);

    const topEvent = this.db
      .prepare(
        `SELECT e.title, e.source, s.risk_score
         FROM scores s
         JOIN events e ON e.event_id = s.event_id
         WHERE s.analyzed_at >= ? AND s.analyzed_at < ?
         ORDER BY s.risk_score DESC, s.analyzed_at DESC
         LIMIT 1`
      )
      .get(startIso, endIso);

    return {
      stats: {
        total_events: Number(stats?.total_events || 0),
        scored_events: Number(stats?.scored_events || 0),
        pushed_ok: Number(stats?.pushed_ok || 0)
      },
      score_bins: {
        "0-20": Number(bins?.b0_20 || 0),
        "20-40": Number(bins?.b20_40 || 0),
        "40-50": Number(bins?.b40_50 || 0),
        "50-60": Number(bins?.b50_60 || 0),
        "60-70": Number(bins?.b60_70 || 0),
        "70-80": Number(bins?.b70_80 || 0),
        "80-100": Number(bins?.b80_100 || 0)
      },
      sources: sources.map((row) => ({
        source_type: row.source_type,
        count: Number(row.cnt || 0)
      })),
      blocked_reasons: blockedReasons.map((row) => ({
        push_reason: row.push_reason,
        count: Number(row.cnt || 0)
      })),
      top_event: topEvent
        ? {
            title: topEvent.title,
            source: topEvent.source,
            risk_score: Number(topEvent.risk_score || 0)
          }
        : null
    };
  }

  getDailySummaryInput(startIso, endIso, maxEvents = 5) {
    const summary = this.getDailyReportSummary(startIso, endIso);
    const limit = Math.max(1, Math.min(10, Number(maxEvents || 5)));
    const seen = new Set();
    const selectedEvents = [];

    const candidateRows = this.db
      .prepare(
        `SELECT payload, pushed_at, push_flag
         FROM push_logs
         WHERE pushed_at >= ? AND pushed_at < ? AND payload IS NOT NULL
         ORDER BY push_flag DESC, pushed_at DESC
         LIMIT 240`
      )
      .all(startIso, endIso);

    for (const row of candidateRows) {
      const payload = safeParseJson(row.payload, null);
      if (!payload?.event?.title) continue;
      const eventId = payload.event_id || payload.event?.event_id || null;
      const dedupKey = eventId || `${payload.event.title}|${payload.event.publish_time || ""}|${payload.event.source || ""}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      selectedEvents.push({
        event_id: eventId,
        title: payload.event.title,
        title_zh: payload.analysis?.title_zh || "",
        source: payload.event.source || "",
        risk_score: Number(payload.scoreResult?.risk_score || 0),
        level: Number(payload.scoreResult?.level || 0),
        regime: payload.scoreResult?.regime || "",
        reasons: Array.isArray(payload.analysis?.reasons) ? payload.analysis.reasons.slice(0, 2) : [],
        asset_actions: Array.isArray(payload.analysis?.asset_actions) ? payload.analysis.asset_actions.slice(0, 3) : [],
        publish_time: payload.event.publish_time || null
      });
    }

    selectedEvents.sort((a, b) => b.risk_score - a.risk_score);
    const events = selectedEvents.slice(0, limit);
    for (const item of events) {
      const key = item.event_id || `${item.title}|${item.publish_time || ""}|${item.source || ""}`;
      seen.add(key);
    }

    if (events.length < limit) {
      const backupRows = this.db
        .prepare(
          `SELECT e.event_id, e.title, e.source, e.publish_time, s.risk_score, s.level, s.regime, s.decision_reasons
           FROM scores s
           JOIN events e ON e.event_id = s.event_id
           WHERE s.analyzed_at >= ? AND s.analyzed_at < ?
           ORDER BY s.risk_score DESC, s.analyzed_at DESC
           LIMIT 60`
        )
        .all(startIso, endIso);

      for (const row of backupRows) {
        const key = row.event_id || `${row.title}|${row.publish_time || ""}|${row.source || ""}`;
        if (seen.has(key)) continue;
        const reasonsRaw = safeParseJson(row.decision_reasons, []);
        events.push({
          event_id: row.event_id,
          title: row.title,
          title_zh: "",
          source: row.source,
          risk_score: Number(row.risk_score || 0),
          level: Number(row.level || 0),
          regime: row.regime || "",
          reasons: Array.isArray(reasonsRaw) ? reasonsRaw.slice(0, 2) : [],
          asset_actions: [],
          publish_time: row.publish_time || null
        });
        seen.add(key);
        if (events.length >= limit) break;
      }
    }

    const marketSnapshot =
      this.db
        .prepare(
          `SELECT ts, confirmation_score, is_data_anomaly, anomaly_reasons, btc_change_1h, equities_change_1h, gold_change_1h, dxy_change_1h
           FROM market_snapshots
           WHERE ts >= ? AND ts < ?
           ORDER BY ts DESC
           LIMIT 1`
        )
        .get(startIso, endIso) ||
      this.db
        .prepare(
          `SELECT ts, confirmation_score, is_data_anomaly, anomaly_reasons, btc_change_1h, equities_change_1h, gold_change_1h, dxy_change_1h
           FROM market_snapshots
           ORDER BY ts DESC
           LIMIT 1`
        )
        .get();

    return {
      report_window: {
        start_iso: startIso,
        end_iso: endIso
      },
      stats: summary.stats,
      score_bins: summary.score_bins,
      sources: summary.sources,
      blocked_reasons: summary.blocked_reasons,
      top_event: summary.top_event,
      events: events.sort((a, b) => b.risk_score - a.risk_score).slice(0, limit),
      market_snapshot: marketSnapshot
        ? {
            ts: marketSnapshot.ts,
            confirmation_score: Number(marketSnapshot.confirmation_score || 0),
            is_data_anomaly: Boolean(marketSnapshot.is_data_anomaly),
            anomaly_reasons: safeParseJson(marketSnapshot.anomaly_reasons, []),
            btc_change_1h: marketSnapshot.btc_change_1h,
            equities_change_1h: marketSnapshot.equities_change_1h,
            gold_change_1h: marketSnapshot.gold_change_1h,
            dxy_change_1h: marketSnapshot.dxy_change_1h
          }
        : null
    };
  }
}
