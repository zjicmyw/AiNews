export function parseSchedule(value) {
  const matched = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!matched) return { hour: 16, minute: 43, text: "16:43" };
  const hour = Math.min(23, Math.max(0, Number.parseInt(matched[1], 10)));
  const minute = Math.min(59, Math.max(0, Number.parseInt(matched[2], 10)));
  return { hour, minute, text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

const DAY_MS = 86400000;
const publicReceipt = (row) => ({
  business_id: row.business_id, kind: row.kind, status: row.status,
  task_id: row.task_id || null, message_id: row.message_id || null,
  accepted_at: row.accepted_at || null, completed_at: row.completed_at || null,
  checked_at: row.checked_at || null
});

// Pure projection. The HTTP reader neither contacts the relay nor reconciles SQLite.
export function buildBusinessDeliveryEvidence(db, config, now = new Date()) {
  const date = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const definitions = [
    { kind: 'opportunity_daily', prefix: 'opportunity:', enabled: config.opportunityDailyReportEnabled, time: config.opportunityDailyReportTimeBj || config.dailyReportTimeBj || '19:04' },
    { kind: 'binance_major_daily', prefix: 'binance-major-news:', enabled: config.binanceMajorNewsEnabled, time: config.binanceMajorNewsDailyTimeBj || '19:01' },
    { kind: 'risk_daily', prefix: '', enabled: config.dailyReportEnabled, time: config.dailyReportTimeBj || '19:04' }
  ];
  const planned = definitions.map((definition) => {
    const todayDue = new Date(`${date}T${parseSchedule(definition.time).text}:00+08:00`);
    const due = todayDue > now ? new Date(todayDue.getTime() - DAY_MS) : todayDue;
    const reportDate = new Date(due.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    return { ...definition, enabled: Boolean(definition.enabled && config.telegramEnabled), reportDate,
      businessId: `${definition.prefix}${reportDate}`, dueAt: due.toISOString(),
      nextDueAt: new Date(due.getTime() + DAY_MS).toISOString() };
  });
  const evidence = db.getBusinessDeliveryEvidence(planned.map((item) => item.businessId), new Date(now.getTime() - 2 * DAY_MS).toISOString());
  evidence.truncated = evidence.receipts.length > 500;
  const reports = planned.map((plan) => {
    const batch = evidence.batches.find((row) => row.group_id === plan.businessId);
    const legacy = evidence.reports.find((row) => row.report_date === plan.businessId);
    const receipts = evidence.receipts.filter((row) => row.group_id === plan.businessId);
    const expected = batch?.expected_parts ?? (legacy ? null : 1);
    const missingParts = batch && receipts.length < expected;
    let state = 'waiting_event';
    if (!plan.enabled) state = 'disabled';
    else if (legacy && !batch) state = 'legacy_unverified';
    else if (receipts.some((row) => row.status === 'failed')) state = 'failed';
    else if (receipts.some((row) => row.status === 'unknown')) state = 'unknown';
    else if (missingParts) state = 'unknown';
    else if (receipts.length && receipts.every((row) => row.status === 'sent')) state = 'sent';
    else if (receipts.length && receipts.every((row) => ['sent', 'suppressed'].includes(row.status))) state = 'suppressed';
    else if (receipts.some((row) => row.status === 'queued')) state = 'queued';
    const timeoutSeconds = plan.kind === 'opportunity_daily'
      ? Math.max(600, Number(config.opportunityHermesTimeoutSec || 600) * Number(config.opportunityMaxQueryJobs || 3) + 300)
      : 1800;
    const overdue = plan.enabled && state === 'waiting_event' && now.getTime() - Date.parse(plan.dueAt) > timeoutSeconds * 1000;
    return { business_id: plan.businessId, report_date: plan.reportDate, kind: plan.kind, enabled: plan.enabled,
      due_at: plan.dueAt, next_due_at: plan.nextDueAt, state, overdue,
      expected_parts: expected, recorded_parts: receipts.length,
      sent_parts: receipts.filter((row) => row.status === 'sent').length,
      submitted_at: batch?.created_at || legacy?.sent_at || null,
      completed_at: state === 'sent' ? receipts.map((row) => row.completed_at).sort().at(-1) || null : null,
      receipts: receipts.map(publicReceipt) };
  });
  const recentEvents = evidence.receipts.filter((row) => !['opportunity_daily', 'binance_major_daily', 'risk_daily'].includes(row.kind)).map(publicReceipt);
  const applicable = reports.filter((row) => row.enabled);
  const failedCount = applicable.filter((row) => row.state === 'failed').length + recentEvents.filter((row) => row.status === 'failed').length;
  const unknownCount = applicable.filter((row) => row.state === 'unknown').length + recentEvents.filter((row) => row.status === 'unknown').length;
  const queuedCount = applicable.filter((row) => row.state === 'queued').length + recentEvents.filter((row) => row.status === 'queued').length;
  const overdueCount = applicable.filter((row) => row.overdue).length;
  const legacyEventCount = Number(evidence.legacy_event_unverified_count || 0);
  const legacyCount = applicable.filter((row) => row.state === 'legacy_unverified').length + legacyEventCount;
  const waiting = applicable.some((row) => ['waiting_event', 'pending', 'waiting_due'].includes(row.state)) || queuedCount > 0;
  const warning = failedCount + unknownCount + overdueCount + legacyCount > 0 || evidence.truncated;
  return { ok: true, observed_at: now.toISOString(),
    coverage: { scope: 'ainews-business-notifications', state: legacyCount || evidence.truncated ? 'partial' : 'complete', legacy_unverified_count: legacyCount, legacy_event_unverified_count: legacyEventCount },
    health: { ok: !warning && !waiting, status: warning ? 'warning' : waiting ? 'waiting' : 'healthy',
      failed_count: failedCount, unknown_count: unknownCount, queued_count: queuedCount, overdue_count: overdueCount },
    reports, recent_events: recentEvents,
    limitations: ['Daily reports use the latest due date; event receipts cover the preceding 48 hours.',
      'Legacy sent_at and push flags record application acceptance, not final delivery. Missing legacy receipts are not replayed.',
      'Gateway sent confirms Telegram delivery, not readership. Partial or unknown submissions require reconciliation, not automatic resending.',
      ...(evidence.truncated ? ['Receipt query exceeded 500 rows; coverage is partial.'] : [])] };
}
