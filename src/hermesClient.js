import { execFile } from "node:child_process";
import { logger } from "./logger.js";

export function isHermesQuotaError(error) {
  return /personal-team-blocked|spending-limit|billing or credits exhausted|out of credits|need a grok subscription/i.test(String(error?.message || error || ""));
}

export function hermesQuotaRetryAt(error) {
  const value = error?.retryAfter || String(error?.message || error || "").match(/retry_after=([^;\s]+)/)?.[1];
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function describeHermesError(error) {
  return isHermesQuotaError(error) ? "Grok 额度或订阅权限不足，采集结果未知；恢复账户权限后等待后续计划采集。" : String(error || "");
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactErrorText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 500);
}

export function buildHermesArgs(config, prompt) {
  return [
    "--profile",
    config.opportunityHermesProfile || "xintel",
    "chat",
    "--query",
    prompt,
    "--quiet",
    "--ignore-rules",
    "--source",
    "tool"
  ];
}

export class HermesClient {
  constructor(config, options = {}) {
    this.config = config || {};
    this.execFileFn = options.execFileFn || execFile;
    this.maxConcurrency = Math.max(1, toInt(options.maxConcurrency ?? this.config.xintelHermesMaxConcurrency, 1));
    this.minIntervalMs = Math.max(0, toInt(options.minIntervalMs ?? this.config.xintelHermesMinIntervalMs, 5000));
    this.queue = [];
    this.active = 0;
    this.lastStartedMs = 0;
    this.timer = null;
    this.stateStore = options.stateStore;
    this.stateKey = JSON.stringify([this.config.opportunityHermesBin || "hermes", this.config.opportunityHermesProfile || "xintel"]);
    const saved = this.stateStore?.getHermesQuotaState?.(this.stateKey);
    this.quotaBlockedUntil = Number.isFinite(saved?.blocked_until_ms) ? saved.blocked_until_ms : 0;
    this.persistenceError = false;
  }

  getStatus() {
    const blocked = Date.now() < this.quotaBlockedUntil;
    return { blocked, reason: blocked ? "quota_exhausted" : null,
      retry_after: blocked ? new Date(this.quotaBlockedUntil).toISOString() : null,
      active: this.active, queued: this.queue.length, persistence_error: this.persistenceError };
  }

  quotaError() {
    const retryAfter = new Date(this.quotaBlockedUntil).toISOString();
    return Object.assign(new Error(`hermes_quota_exhausted:spending-limit:retry_after=${retryAfter}`), {
      code: "HERMES_QUOTA_EXHAUSTED", retryAfter
    });
  }

  saveQuotaState() {
    try {
      this.stateStore?.setHermesQuotaState?.(this.stateKey, this.quotaBlockedUntil);
      this.persistenceError = false;
    } catch {
      this.persistenceError = true;
      logger.warn("hermes_quota_state_persist_failed");
    }
  }

  call(prompt) {
    if (this.getStatus().blocked) return Promise.reject(this.quotaError());
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, resolve, reject });
      this.schedule();
    });
  }

  schedule() {
    if (this.getStatus().blocked) {
      clearTimeout(this.timer);
      this.timer = null;
      for (const job of this.queue.splice(0)) job.reject(this.quotaError());
      return;
    }
    if (this.timer) return;
    if (this.active >= this.maxConcurrency || this.queue.length === 0) return;

    const waitMs = Math.max(0, this.minIntervalMs - (Date.now() - this.lastStartedMs));
    if (waitMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.schedule();
      }, waitMs);
      return;
    }

    const job = this.queue.shift();
    this.active += 1;
    this.lastStartedMs = Date.now();
    this.execute(job.prompt)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active -= 1;
        this.schedule();
      });
    this.schedule();
  }

  execute(prompt) {
    if (Date.now() < this.quotaBlockedUntil) {
      return Promise.reject(this.quotaError());
    }
    const timeoutMs = Math.max(10, Math.min(600, toInt(this.config.opportunityHermesTimeoutSec, 120))) * 1000;
    return new Promise((resolve, reject) => {
      this.execFileFn(
        this.config.opportunityHermesBin || "hermes",
        buildHermesArgs(this.config, prompt),
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
            // Hermes can put provider failures on stdout and only the session ID on stderr.
            const quotaExhausted = isHermesQuotaError(`${output}\n${errorOutput}`);
            if (quotaExhausted) {
              const backoffSec = Math.max(0, Math.min(7 * 86400, toInt(this.config.opportunityQuotaErrorBackoffSec, 43200)));
              this.quotaBlockedUntil = Date.now() + backoffSec * 1000;
              this.saveQuotaState();
            }
            const stderrDetail = quotaExhausted ? "hermes_quota_exhausted:spending-limit" : compactErrorText(errorOutput || output);
            const wrapped = quotaExhausted ? this.quotaError() : new Error(
              isTimeout
                ? `hermes_timeout_after_${timeoutMs}ms`
                : `hermes_failed:${error.code || error.signal || "unknown"}${stderrDetail ? `:${stderrDetail}` : ""}`
            );
            wrapped.stdout = output;
            wrapped.stderr = errorOutput;
            reject(wrapped);
            return;
          }
          if (this.quotaBlockedUntil && !this.getStatus().blocked) {
            this.quotaBlockedUntil = 0;
            this.saveQuotaState();
          }
          resolve(output || errorOutput);
        }
      );
    });
  }
}
