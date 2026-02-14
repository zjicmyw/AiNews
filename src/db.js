import Database from "better-sqlite3";
import crypto from "node:crypto";
import { ensureDirForFile, nowSec, normalizeTitle } from "./utils.js";

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

      CREATE INDEX IF NOT EXISTS idx_events_ingest_time ON events(ingest_time);
      CREATE INDEX IF NOT EXISTS idx_push_logs_pushed_at ON push_logs(pushed_at);
      CREATE INDEX IF NOT EXISTS idx_push_logs_dedup_key ON push_logs(dedup_key);
      CREATE INDEX IF NOT EXISTS idx_x_user_cache_updated_at ON x_user_cache(updated_at);
      CREATE INDEX IF NOT EXISTS idx_x_since_cache_updated_at ON x_since_cache(updated_at);
    `);
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

  getStats() {
    const events = this.db.prepare(`SELECT COUNT(*) AS cnt FROM events`).get();
    const pushes = this.db.prepare(`SELECT COUNT(*) AS cnt FROM push_logs WHERE push_flag = 1`).get();
    return {
      total_events: Number(events?.cnt || 0),
      total_pushes: Number(pushes?.cnt || 0),
      now_sec: nowSec()
    };
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

  hasDailyReportSent(reportDate) {
    if (!reportDate) return false;
    const row = this.db.prepare(`SELECT report_date FROM daily_reports WHERE report_date = ? LIMIT 1`).get(reportDate);
    return Boolean(row?.report_date);
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
        scheduledTime || "16:32",
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
}
