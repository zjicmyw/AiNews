import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbClient } from '../src/db.js';
import { TelegramNotifier } from '../src/notifier/telegram.js';
import { buildBusinessDeliveryEvidence } from '../src/businessDelivery.js';
import { EnginePipeline } from '../src/pipeline.js';
import { createHttpServer } from '../src/httpServer.js';

const config = { telegramEnabled: true, telegramMode: 'relay', telegramServiceUrl: 'http://127.0.0.1:9',
  telegramApiKey: 'fixture-key', telegramChatId: 'fixture-chat', opportunityDailyReportEnabled: true,
  opportunityDailyReportTimeBj: '19:04', binanceMajorNewsEnabled: false, dailyReportEnabled: false,
  keywordsFile: '/does-not-exist', suppressKeywordsFile: '/does-not-exist', opportunityMonitorEnabled: false,
  securityIncidentMonitorEnabled: false };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainews-delivery-test-'));
  const db = new DbClient(path.join(dir, 'test.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}
function mockFetch(t, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => { globalThis.fetch = original; });
}
function age(db, id) { db.db.prepare("UPDATE notification_delivery SET checked_at='2020-01-01T00:00:00Z' WHERE business_id=?").run(id); }
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('relay acceptance is queued; duplicate business ID never posts again and final receipt persists', async (t) => {
  const db = fixture(t); let posts = 0;
  mockFetch(t, async (url, options) => {
    if (options.method === 'POST') { posts++; return response({ success: true, status: 'queued', taskId: 'task-1' }, 202); }
    assert.equal(new URL(url).pathname, '/message-status');
    return response({ success: true, status: 'sent', taskId: 'task-1', messageId: 51, completedAt: '2026-09-08T11:04:03Z' });
  });
  const notifier = new TelegramNotifier(config, db);
  assert.equal((await notifier.send({ message: 'fixture message', businessId: 'event-1' })).status, 'queued');
  assert.equal(db.getNotificationDelivery('event-1').message_id, null);
  await notifier.send({ message: 'fixture message', businessId: 'event-1' });
  assert.equal(posts, 1);
  age(db, 'event-1'); await notifier.reconcilePending();
  assert.equal(db.getNotificationDelivery('event-1').status, 'sent');
  assert.equal(db.getNotificationDelivery('event-1').message_id, '51');
  await new TelegramNotifier(config, db).send({ message: 'fixture message', businessId: 'event-1' });
  assert.equal(posts, 1);
});

test('unknown transport keeps intent and reconciles by idempotency without replaying POST', async (t) => {
  const db = fixture(t); let posts = 0;
  mockFetch(t, async (url, options) => {
    if (options.method === 'POST') { posts++; throw new Error('transport'); }
    assert.equal(new URL(url).pathname, '/message-receipt');
    assert.equal(new URL(url).searchParams.has('idempotencyKey'), true);
    return response({ success: true, status: 'sent', taskId: 'recovered', messageId: 8, idempotencyKey: new URL(url).searchParams.get('idempotencyKey') });
  });
  const notifier = new TelegramNotifier(config, db);
  assert.equal((await notifier.send({ message: 'fixture', businessId: 'unknown-1' })).status, 'unknown');
  await notifier.send({ message: 'fixture', businessId: 'unknown-1' });
  age(db, 'unknown-1'); await notifier.reconcilePending();
  assert.equal(posts, 1); assert.equal(db.getNotificationDelivery('unknown-1').status, 'sent');
});

test('HTTP 2xx invalid JSON is unknown; suppression is never sent; retry_scheduled is queued', async (t) => {
  const db = fixture(t); let i = 0;
  mockFetch(t, async () => [new Response('not-json'), response({success:true,status:'suppressed'}), response({success:true,status:'retry_scheduled',taskId:'retry'})][i++]);
  const notifier = new TelegramNotifier(config, db);
  assert.equal((await notifier.send({ message: 'a', businessId: 'a' })).status, 'unknown');
  assert.equal((await notifier.send({ message: 'b', businessId: 'b' })).status, 'suppressed');
  assert.equal((await notifier.send({ message: 'c', businessId: 'c' })).status, 'queued');
});

test('gateway failure and expired are final failed; sent without message ID is unknown', (t) => {
  const notifier = new TelegramNotifier(config);
  assert.equal(notifier.parseReceipt({success:true,status:'expired'},true,'relay').status,'failed');
  assert.equal(notifier.parseReceipt({success:false,status:'failed'},false,'relay').status,'failed');
  assert.equal(notifier.parseReceipt({success:true,status:'sent',taskId:'x'},true,'relay').status,'unknown');
  assert.equal(notifier.parseReceipt({ok:true,result:{message_id:9}},true,'direct').status,'sent');
  assert.equal(notifier.parseReceipt({ok:true},true,'direct').status,'unknown');
});

test('gateway 404 and query failure do not manufacture a sent receipt', async (t) => {
  const db = fixture(t); const notifier = new TelegramNotifier(config, db);
  mockFetch(t, async (_url, options) => options.method === 'POST'
    ? response({success:true,status:'queued',taskId:'gone'},202) : response({success:false},404));
  await notifier.send({message:'fixture',businessId:'gone'}); age(db,'gone');
  await notifier.reconcilePending();
  assert.equal(db.getNotificationDelivery('gone').status,'unknown');
  assert.equal(db.getNotificationDelivery('gone').reason,'receipt_unavailable');
});

test('same business ID with a different payload cannot trigger a duplicate post', async (t) => {
  const db = fixture(t); let posts = 0;
  mockFetch(t, async () => { posts++; return response({success:true,status:'sent',messageId:4,taskId:'x'}); });
  const notifier = new TelegramNotifier(config,db);
  await notifier.send({message:'before',businessId:'same'});
  assert.equal((await notifier.send({message:'after',businessId:'same'})).reason,'business_payload_conflict');
  assert.equal(posts,1);
});

test('legacy daily report remains unverified and prevents pipeline replay', async (t) => {
  const db = fixture(t); const now = new Date('2026-09-08T12:00:00Z');
  db.saveDailyReport({reportDate:'opportunity:2026-09-08',scheduledTime:'19:04',payload:{}});
  const body=buildBusinessDeliveryEvidence(db,config,now);
  assert.equal(body.reports[0].state,'legacy_unverified');
  assert.equal(body.coverage.state,'partial'); assert.equal(body.health.failed_count,0);
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  db.saveDailyReport({reportDate:`opportunity:${today}`,scheduledTime:'00:00',payload:{}});
  const pipeline=new EnginePipeline({db,config:{...config,opportunityDailyReportTimeBj:'00:00'},tradingViewSignalStore:{}});
  pipeline.notifier={send:async()=>{throw Error('must not send');}};
  pipeline.opportunityMonitor.runOnce=async()=>{throw Error('must not collect');};
  await pipeline.maybeSendOpportunityDailyReport('test');
});

test('report chooses latest due day and partial multipart delivery cannot pass', async (t) => {
  const db=fixture(t); const now=new Date('2026-09-08T01:00:00Z');
  db.claimNotificationBatch({groupId:'opportunity:2026-09-07',kind:'opportunity_daily',reportDate:'2026-09-07',scheduledTime:'19:04',expectedParts:2});
  let body=buildBusinessDeliveryEvidence(db,config,now);
  assert.equal(body.reports[0].report_date,'2026-09-07'); assert.equal(body.reports[0].state,'unknown');
  db.claimNotificationDelivery({business_id:'p1',group_id:'opportunity:2026-09-07',kind:'opportunity_daily',mode:'relay',idempotency_key:'key',payload_hash:'hash',created_at:now.toISOString()});
  db.updateNotificationDelivery('p1',{status:'sent',messageId:1,taskId:'t1',completedAt:now.toISOString()});
  body=buildBusinessDeliveryEvidence(db,config,now);
  assert.equal(body.reports[0].sent_parts,1);assert.equal(body.reports[0].recorded_parts,1);
  assert.equal(body.health.status,'warning');
});

test('fully correlated report passes and expired historical legacy does not taint current report', (t) => {
  const db=fixture(t); const now=new Date('2026-09-08T12:00:00Z');
  db.saveDailyReport({reportDate:'opportunity:2026-09-01',scheduledTime:'19:04',payload:{}});
  db.claimNotificationBatch({groupId:'opportunity:2026-09-08',kind:'opportunity_daily',reportDate:'2026-09-08',scheduledTime:'19:04',expectedParts:1});
  db.claimNotificationDelivery({business_id:'p1',group_id:'opportunity:2026-09-08',kind:'opportunity_daily',mode:'relay',idempotency_key:'key',payload_hash:'hash',created_at:now.toISOString()});
  db.updateNotificationDelivery('p1',{status:'sent',messageId:1,taskId:'t1',completedAt:now.toISOString()});
  const body=buildBusinessDeliveryEvidence(db,config,now);
  assert.equal(body.health.status,'healthy');assert.equal(body.coverage.state,'complete');
});

test('GET delivery evidence is a pure read and omits message, chat, keys and raw errors', async (t) => {
  const db=fixture(t);
  db.claimNotificationDelivery({business_id:'event',group_id:'event',kind:'security_incident',mode:'relay',idempotency_key:'private-key',payload_hash:'private-hash',created_at:new Date().toISOString()});
  db.updateNotificationDelivery('event',{status:'unknown',reason:'fixture-sensitive-error'});
  const server=createHttpServer({config:{...config,appPort:0},db,getRuntimeStatus:()=>({}),tradingViewSignalStore:{}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const before=db.db.prepare('SELECT total_changes() AS n').get().n;
  const result=await fetch(`http://127.0.0.1:${server.address().port}/api/business-delivery`);
  assert.equal(result.status,200); const text=await result.text();
  assert.equal(db.db.prepare('SELECT total_changes() AS n').get().n,before);
  for(const forbidden of ['fixture-key','fixture-chat','private-key','private-hash','fixture-sensitive-error','idempotency_key','payload_hash']) assert.equal(text.includes(forbidden),false);
});

test('a receipt for another gateway task cannot satisfy the current business event', async (t) => {
  const db=fixture(t);const notifier=new TelegramNotifier(config,db);
  mockFetch(t,async (_url,options)=>options.method==='POST'
    ?response({success:true,status:'queued',taskId:'expected'},202)
    :response({success:true,status:'sent',taskId:'other',messageId:123}));
  await notifier.send({message:'fixture',businessId:'identity'});age(db,'identity');
  await notifier.reconcilePending();
  assert.equal(db.getNotificationDelivery('identity').status,'unknown');
  assert.equal(db.getNotificationDelivery('identity').reason,'receipt_identity_mismatch');
});

test('an interrupted report batch is not regenerated or resent after restart', async (t) => {
  const db=fixture(t);const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  db.claimNotificationBatch({groupId:`opportunity:${today}`,kind:'opportunity_daily',reportDate:today,scheduledTime:'00:00',expectedParts:1});
  const pipeline=new EnginePipeline({db,config:{...config,opportunityDailyReportTimeBj:'00:00'},tradingViewSignalStore:{}});
  let sideEffects=0;
  pipeline.notifier={send:async()=>{sideEffects++;}};
  pipeline.opportunityMonitor.runOnce=async()=>{sideEffects++;};
  await pipeline.maybeSendOpportunityDailyReport('restart');
  assert.equal(sideEffects,0);
});

test('delivery schema initialization is additive and preserves legacy rows on reopen', (t) => {
  const db=fixture(t);
  db.saveDailyReport({reportDate:'opportunity:2026-09-01',scheduledTime:'19:04',payload:{legacy:true}});
  const before=db.db.prepare('SELECT * FROM daily_reports').all();
  db.init();
  assert.deepEqual(db.db.prepare('SELECT * FROM daily_reports').all(),before);
  assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_delivery'").get());
});

test('disabled report does not claim its date and configured restart may submit it once', async (t) => {
  const db=fixture(t); const runConfig={...config,telegramEnabled:false,opportunityDailyReportTimeBj:'00:00'};
  const pipeline=new EnginePipeline({db,config:runConfig,tradingViewSignalStore:{}});
  let collections=0;let posts=0;
  pipeline.opportunityMonitor.runOnce=async()=>{collections++;return {ok:true};};
  mockFetch(t,async()=>{posts++;return response({success:true,status:'sent',taskId:'first',messageId:1});});
  await pipeline.maybeSendOpportunityDailyReport('disabled');
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM notification_batches').get().n,0);
  assert.equal(collections,0);assert.equal(posts,0);
  runConfig.telegramEnabled=true;
  await pipeline.maybeSendOpportunityDailyReport('enabled');
  assert.equal(posts,1);
  await pipeline.maybeSendOpportunityDailyReport('again');assert.equal(posts,1);
});

test('missing configuration is visible without submission and may be repaired before first post', async (t) => {
  const db=fixture(t);const mutableConfig={...config,telegramApiKey:'',opportunityDailyReportEnabled:false};
  const notifier=new TelegramNotifier(mutableConfig,db);let posts=0;
  mockFetch(t,async()=>{posts++;return response({success:true,status:'sent',taskId:'repair',messageId:9});});
  assert.equal((await notifier.send({message:'event',businessId:'config-fail',kind:'security_incident'})).status,'failed');
  assert.equal(posts,0);
  const evidence=buildBusinessDeliveryEvidence(db,mutableConfig);
  assert.equal(evidence.health.status,'warning');assert.equal(evidence.health.failed_count,1);
  mutableConfig.telegramApiKey='fixed-fixture-key';
  assert.equal((await notifier.send({message:'event',businessId:'config-fail',kind:'security_incident'})).status,'sent');
  assert.equal(posts,1);
});

test('unknown first segment resumes only frozen unsubmitted remainder after same-key final receipt', async (t) => {
  const db=fixture(t);const pipeline=new EnginePipeline({db,config,tradingViewSignalStore:{}});
  let posts=0;const messages=[];
  mockFetch(t,async(url,options)=>{
    if(options.method==='POST'){
      const body=JSON.parse(options.body);posts++;messages.push(body.message);
      if(posts===1) throw Error('unknown transport');
      return response({success:true,status:'sent',taskId:`task-${posts}`,messageId:posts});
    }
    return response({success:true,status:'sent',taskId:'task-1',messageId:1,idempotencyKey:new URL(url).searchParams.get('idempotencyKey')});
  });
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);const key=`opportunity:${today}`;
  await pipeline.submitDailyReportBatch({reportKey:key,kind:'opportunity_daily',reportDate:today,
    scheduledTime:'00:00',messages:['original first','original second'],chatId:'frozen-chat',payload:{fixture:true}});
  assert.equal(posts,1);assert.equal(db.hasDailyReportSent(key),false);
  await pipeline.resumePendingDailyReports();assert.equal(posts,1);
  age(db,`${key}:part:1`);await pipeline.notifier.reconcilePending();
  await pipeline.resumePendingDailyReports();assert.equal(posts,2);
  assert.deepEqual(messages,['original first','original second']);assert.equal(db.hasDailyReportSent(key),true);
  await pipeline.resumePendingDailyReports();assert.equal(posts,2);
});

test('short-hour and invalid disabled schedules use the same normalization as pipeline', (t) => {
  const db=fixture(t);const body=buildBusinessDeliveryEvidence(db,{...config,opportunityDailyReportTimeBj:'9:04',dailyReportTimeBj:'invalid'},new Date('2026-09-08T02:00:00Z'));
  assert.equal(body.reports[0].due_at,'2026-09-08T01:04:00.000Z');
  assert.equal(body.reports[2].state,'disabled');
});

test('late POST timeout cannot downgrade an already reconciled sent receipt', async (t) => {
  const db=fixture(t);const notifier=new TelegramNotifier(config,db);let rejectPost;
  mockFetch(t,async(url,options)=>{
    if(options.method==='POST') return new Promise((_resolve,reject)=>{rejectPost=reject;});
    return response({success:true,status:'sent',taskId:'race-task',messageId:91,idempotencyKey:new URL(url).searchParams.get('idempotencyKey')});
  });
  const sending=notifier.send({message:'race',businessId:'race'});
  await notifier.reconcilePending();assert.equal(db.getNotificationDelivery('race').status,'sent');
  rejectPost(Error('late timeout'));
  assert.equal((await sending).status,'sent');assert.equal(db.getNotificationDelivery('race').status,'sent');
  assert.equal(db.getNotificationDelivery('race').message_id,'91');
});

test('legacy accepted event flag without correlated receipt is partial, not absence of events', (t) => {
  const db=fixture(t);
  db.db.prepare("INSERT INTO push_logs (event_id,push_flag,push_reason,pushed_at) VALUES (NULL,1,'sent',?)").run(new Date().toISOString());
  const body=buildBusinessDeliveryEvidence(db,{...config,opportunityDailyReportEnabled:false});
  assert.equal(body.coverage.state,'partial');assert.equal(body.coverage.legacy_event_unverified_count,1);
  assert.equal(body.health.status,'warning');assert.equal(body.health.failed_count,0);
});

test('repairing old preflight failure opens a fresh real-submission reconciliation window', async (t) => {
  const db=fixture(t);const mutable={...config,telegramApiKey:''};const notifier=new TelegramNotifier(mutable,db);
  await notifier.send({message:'old-preflight',businessId:'old-preflight',kind:'security_incident'});
  db.db.prepare("UPDATE notification_delivery SET created_at='2020-01-01T00:00:00Z' WHERE business_id='old-preflight'").run();
  mutable.telegramApiKey='fixture-key';
  mockFetch(t,async()=>response({success:true,status:'queued',taskId:'fresh'},202));
  await notifier.send({message:'old-preflight',businessId:'old-preflight',kind:'security_incident'});
  age(db,'old-preflight');assert.equal(db.getNotificationReconciliation().length,1);
  const body=buildBusinessDeliveryEvidence(db,{...mutable,opportunityDailyReportEnabled:false});
  assert.equal(body.health.queued_count,1);assert.equal(body.health.status,'waiting');
});
