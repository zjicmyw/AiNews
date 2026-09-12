import { config } from "../src/config.js";
import { DbClient } from "../src/db.js";
import { OpportunityMonitor } from "../src/opportunityMonitor.js";

const db = new DbClient(config.dbPath);
try {
  const latest = db.getLatestOpportunityRun();
  const failedNames = (latest?.job_stats || [])
    .filter((job) => ["error", "parse_failed"].includes(job.status))
    .map((job) => job.name)
    .filter(Boolean);
  if (!latest || !["partial", "error"].includes(latest.status) || failedNames.length === 0) {
    console.log(JSON.stringify({ skipped: true, reason: "no_failed_jobs", latest_run_id: latest?.id || null }));
    process.exitCode = 0;
  } else {
    const monitor = new OpportunityMonitor({ config, db });
    const result = await monitor.runOnce("manual_failed_job_recovery", { onlyJobNames: [...new Set(failedNames)] });
    console.log(JSON.stringify({ latest_run_id: latest.id, failed_jobs: failedNames, result }));
    if (result.ok !== true) process.exitCode = 1;
  }
} finally {
  db.close();
}
