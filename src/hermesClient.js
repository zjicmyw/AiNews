import { execFile } from "node:child_process";

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
    this.quotaBlockedUntil = 0;
  }

  call(prompt) {
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, resolve, reject });
      this.schedule();
    });
  }

  schedule() {
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
      return Promise.reject(new Error(`hermes_quota_exhausted:spending-limit:retry_after=${new Date(this.quotaBlockedUntil).toISOString()}`));
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
            const quotaExhausted = /personal-team-blocked:spending-limit|billing or credits exhausted|out of credits/i.test(`${output}\n${errorOutput}`);
            if (quotaExhausted) {
              const backoffSec = Math.max(0, Math.min(7 * 86400, toInt(this.config.opportunityQuotaErrorBackoffSec, 43200)));
              this.quotaBlockedUntil = Date.now() + backoffSec * 1000;
            }
            const stderrDetail = quotaExhausted ? "hermes_quota_exhausted:spending-limit" : compactErrorText(errorOutput || output);
            const wrapped = new Error(
              isTimeout
                ? `hermes_timeout_after_${timeoutMs}ms`
                : `hermes_failed:${error.code || error.signal || "unknown"}${stderrDetail ? `:${stderrDetail}` : ""}`
            );
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
}
