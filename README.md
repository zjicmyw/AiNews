# AI News Risk Engine (V1)

Crypto 风险新闻辅助系统：采集宏观/地缘新闻，结合市场确认，计算风险分级并推送 Telegram。

## 已实现模块
### Hermes 订阅接入恢复（2026-09-08）

- 决定：沿用现有日报的 `xintel` profile，通过 `xai-oauth` 接入 Grok 4.5 与 X Search，替代丢失的 Hermes 安装；不新增日报调度。
- 程序入口：`/Users/easthash/.local/bin/hermes`；源码及独立 Python 环境：`/Users/easthash/code/hermes-agent`，恢复版本 `d4d4ecfae0c135b7bb52ff4f782ffef17bbc90c7`。
- profile：`/Users/easthash/.hermes/profiles/xintel`。登录命令：`/Users/easthash/.local/bin/hermes --profile default auth add xai-oauth --no-browser`；凭据保存在默认用户凭据库，xintel 读取共享授权。该版本在新 profile 首次添加 OAuth 时可能误走 update-only 保存分支，因此不使用 profile 内首次登录。用户在官方浏览器页面完成授权，凭据不写入项目。
- 当前验收：入口、订阅授权、Grok 4.5 推理与真实 X Search 已验证；会话 `20260908_192431_7f0d5c` 的工具回执为 `success=true`、`credential_source=xai-oauth`。完整日报生成与最终送达仍以之后的实际业务批次核验，本次未补发日报。

- Collector: RSS + GDELT + X 白名单
- Analyzer: AI 可配置（Grok/Gemini）结构化 JSON（失败自动降级到启发式）
- Market: BTC / 美股代理 / 黄金 / DXY(代理) 的主备源与异常检测
- Risk Engine: RiskScore、分级、Fail-Closed、去重与冷却
- Notifier: Telegram 中文推送
- API: `GET /status.json`, `GET /health`, `POST /webhook/tradingview`
- Storage: SQLite 持久化（`events/scores/market_snapshots/push_logs/system_health`）

## 快速开始
1. 安装依赖
```bash
npm install
```

2. 复制环境变量模板
```bash
cp .env.example .env
```

3. 填写 `.env`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_MODE=relay`
- `APP_PORT`（例如 `3100`，避免与 Telegram 服务端口冲突）
- `TELEGRAM_SERVICE_URL`（例如 `http://127.0.0.1:3000`）
- `TELEGRAM_API_KEY`
- `AI_PROVIDER`（`grok` 或 `gemini`）
- `AI_API_KEY`
- `AI_MODEL`
- `FINNHUB_API_KEY`
- `X_BEARER_TOKEN`（如需 X）

4. 启动
```bash
npm start
```

## 关键配置
- `POLL_INTERVAL_SEC=180`
- `APP_PORT=3100`
- `LEVEL2_THRESHOLD=60`
- `X_LEVEL2_THRESHOLD_LOWER_FOR_X=10`（X 来源 Level2 阈值额外降低 10）
- `LEVEL3_THRESHOLD=75`
- `MARKET_CONFIRM_STRONG=70`
- `ENABLE_ENGINE_CYCLE=true`（只跑机会监控网页时可设为 `false`，避免旧新闻采集循环空跑写日志）
- `LEVEL3_DAILY_LIMIT=3`
- `DEDUP_WINDOW_MIN=60`
- `LEVEL2_COOLDOWN_MIN=90`
- `NEWS_LOOKBACK_MIN=120`
- `AI_PROVIDER=grok`
- `AI_MODEL=grok-4-fast-reasoning`
- `AI_MAX_REQUESTS_PER_MIN=20`
- `AI_BLOCKED_COOLDOWN_SEC=900`
- `AI_LLM_CANDIDATE_MIN_SCORE=55`
- `AI_EVENT_RAW_TEXT_MAX_CHARS=500`
- `EQUITIES_PRIMARY_SOURCE=finnhub`
- `USE_MARKET_HOURS_STALE_GUARD=true`
- `US_MARKET_CLOSED_STALE_SECONDS=259200`
- `X_MIN_REQUEST_INTERVAL_SEC=60`
- `X_USERS_PER_CYCLE=0`（0 表示每轮抓取白名单全部账号）
- `X_MAX_RESULTS_PER_USER=5`
- `X_EXCLUDE_RETWEETS_REPLIES=true`
- `TELEGRAM_MODE=relay`
- `TELEGRAM_SERVICE_URL=http://127.0.0.1:3000`
- `TELEGRAM_API_KEY=[REDACTED]`
- `TELEGRAM_SHARED_ENV_PATH=/path/to/telegramBot/.env`（可选；仅从共享文件读取 `API_KEY`，避免复制 relay 密钥）
- `DAILY_REPORT_ENABLED=true`
- `DAILY_REPORT_TIME_BJ=19:04`
- `DAILY_REPORT_CHAT_ID=-5535517204`
- `DAILY_REPORT_CHECK_INTERVAL_SEC=30`
- `DAILY_REPORT_MAX_EVENTS=5`
- `DAILY_REPORT_MESSAGE_MAX_CHARS=1200`
- `OPPORTUNITY_MONITOR_ENABLED=true`
- `OPPORTUNITY_INTERVAL_SEC=86400`（仅在 `interval` 模式使用）
- `OPPORTUNITY_SCHEDULE_MODE=daily_report`（默认由机会日报每天触发一次采集；不会在进程重启时额外采集）
- `OPPORTUNITY_COLLECTION_TYPES=launch,pre_tge`（当前只采集打新与 Pre-TGE）
- `OPPORTUNITY_DAILY_REPORT_ENABLED=true`
- `OPPORTUNITY_DAILY_REPORT_TIME_BJ=19:04`
- `OPPORTUNITY_DAILY_REPORT_CHAT_ID=-5535517204`（默认跟随 `DAILY_REPORT_CHAT_ID`）
- `OPPORTUNITY_DAILY_REPORT_MAX_ITEMS=8`
- `OPPORTUNITY_DAILY_REPORT_MAX_CHARS=3500`
- `OPPORTUNITY_HERMES_BIN=hermes`
- `OPPORTUNITY_HERMES_PROFILE=xintel`
- `OPPORTUNITY_HERMES_TIMEOUT_SEC=240`
- `XINTEL_HERMES_MAX_CONCURRENCY=1`（机会监控和安全事件监控共享 xintel/Hermes 队列，默认串行）
- `XINTEL_HERMES_MIN_INTERVAL_MS=5000`（共享队列两次 Hermes 调用之间的最小间隔）
- `OPPORTUNITY_LOOKBACK_HOURS=24`
- `OPPORTUNITY_STALE_AFTER_HOURS=1440`（无固定截止/截止未知机会的兜底展示窗口；有明确截止时间的机会未到期就继续展示）
- `OPPORTUNITY_MAX_FOLLOWUPS=1`
- `OPPORTUNITY_FOCUSED_QUERIES_ENABLED=false`（当前固定使用打新与 Pre-TGE 两个专题）
- `OPPORTUNITY_QUERY_MATRIX_ENABLED=true`（兼容旧查询计划；固定类型模式不会采集其他专题）
- `OPPORTUNITY_ADAPTIVE_QUERY_PLAN_ENABLED=true`（主查询超时后，下一轮自动降级为更小的专题查询）
- `OPPORTUNITY_MAX_QUERY_JOBS=2`（每天仅执行打新与 Pre-TGE 两个 xintel 查询）
- `OPPORTUNITY_EMPTY_RESPONSE_BACKOFF_SEC=3600`（xintel/Hermes 连续空响应时暂停实际调用，避免日志刷屏）
- `OPPORTUNITY_ENRICHMENT_ENABLED=true`（搜索后补全官方公告链接和截止时间）
- `OPPORTUNITY_ENRICHMENT_MAX_ITEMS=5`
- `OPPORTUNITY_EXISTING_ENRICHMENT_MAX_ITEMS=0`（暂停补查旧类别，避免额外消耗）
- `OPPORTUNITY_ENRICHMENT_RETRY_COOLDOWN_HOURS=12`（补查无结果后多久再重试）
- `OPPORTUNITY_OFFICIAL_CRAWL_TIMEOUT_SEC=15`
- `OPPORTUNITY_GROK_DEADLINE_FALLBACK_ENABLED=true`
- `OPPORTUNITY_GROK_DEADLINE_FALLBACK_MAX=1`
- `SECURITY_INCIDENT_MONITOR_ENABLED=true`（xintel 链上安全事件监控）
- `SECURITY_INCIDENT_INTERVAL_SEC=1200`（每 20 分钟检查一次）
- `SECURITY_INCIDENT_LARGE_USD=5000000`（大额损失阈值，达到后发危急警报）
- `SECURITY_INCIDENT_CRITICAL_CHAT_ID=-5519280405`
- `SECURITY_INCIDENT_ANOMALY_CHAT_ID=-5363003109`
- `SUPPRESS_KEYWORDS_FILE=./config/suppress_keywords.txt`
- `ENABLE_TRADINGVIEW_WEBHOOK=true`
- `TRADINGVIEW_WEBHOOK_SECRET=[REDACTED]`（启用 TradingView webhook 时必须配置；为空或未配置会 fail-closed 拒绝请求，返回 `webhook_secret_missing`）

## 接口
- `GET /status.json`
- `GET /health`
- `GET /opportunities`（xintel/Grok 高收益机会监控网页）
- `GET /api/opportunities`
- `GET /api/security-incidents`（xintel 链上安全事件监控状态、最近事件和跳过原因）
- `GET /api/opportunities/runs/latest`
- `POST /webhook/tradingview`
  - Header: `x-tradingview-secret: [REDACTED]`
  - 当 `ENABLE_TRADINGVIEW_WEBHOOK=true` 但 `TRADINGVIEW_WEBHOOK_SECRET` 为空或未配置时，请求会 fail-closed 拒绝，当前返回 `webhook_secret_missing`。
  - Body 示例：
```json
{
  "symbol": "BTCUSDT",
  "direction": "risk_off",
  "note": "breakdown"
}
```

## 注意
- 日志修复决定（2026-09-27，用户要求“根据日志优化和修复”）：针对 9 月 24-26 日额度耗尽后逐批重复失败、重启丢失退避和额度错误分类不明，新增 SQLite `hermes_quota_state`（按 Hermes 路径与 profile 隔离），以统一到期时间持久化退避；排队调用直接拒绝，不等待正常调用间隔，不滑动延长退避。重大消息只记录首个额度失败，剩余批次记为 skipped，已成功部分保留但不声称完整覆盖。`/status.json.hermes` 与机会 monitor 暴露 blocked/retry_after/persistence_error，run_health 保持失败但显示明确额度原因；退避到期仅表示可重试，不代表账户已恢复。替代 9 月 22 日“仅进程内退避”实现，不改变群组、计划时间、失败事实或 9 月 23 日停用安全专项监控的决定。验收覆盖持久化重开、到期、排队、部分采集、API 与文案；账户恢复和下一次自然日报回执仍分别核验，不额外调用模型或补发历史 unknown。
- 本轮验证（2026-09-27 12:08 北京时间）：资源守卫全量测试 198/198 通过（回执 `20260927T120734-4e7ea338`），JS 语法与 diff 检查通过；SQLite 备份后部署至现有 `ai-news:3117`。线上 API 已将 run 358 归为 quota_exhausted，历史 status=error 不改写；新状态表已创建，安全 monitor 仍 disabled，无新增采集 run。机会日报 `opportunity:2026-09-26:part:1` 仍为 unknown，未重发；已有 Telegram async 修复保留并纳入全量测试。最新真实数据及下一次自然发送分别待验收，不影响本轮代码与部署结项。
- 验收决定更新（2026-09-22，用户要求避免外部采集长期阻塞优化交付）：代码/回归、部署生效、真实采集、业务送达分别记录。对不改变数据采集与资金告警正确性的改动，可用受控 fixture 验收并交付；外部额度、历史补采或自然事件缺口单列，不拖住无关优化，也不将未验证填成通过。新错误或依赖恢复才重开相应验收，不为消除 Guardian 红灯将 error 改为 ok。本规则不宣称其他项目的 holder 数据已验收。
- 2026-09-22 Guardian 事故 `INC-20260922-a713a48b-9fb5-446e-b943-a92e2009ba9c`：机会 run 354 的原始响应为 Grok `personal-team-blocked:spending-limit`。修复 Hermes stdout 额度错误被 stderr session ID 遮蔽的问题，并用共享客户端按现有 `OPPORTUNITY_QUOTA_ERROR_BACKOFF_SEC`（默认 12 小时）退避，后续排队任务在退避期间不启动子进程。退避状态在进程内，重启会重新尝试；不自动充值、切换供应商或重放当日日报。账户额度/订阅恢复后才能确认真实采集恢复，Guardian 最近失败记录保持真实。
- 决定（2026-09-21，用户补充收购类消息重要）：重大新闻新增 `acquisition`，主动覆盖收购、被收购、合并、控制权变更、核心资产出售及并购终止，最高 9 分。官方确认的重大签约/完成/终止即使代币安排未知也收录，不再被价格催化门槛误滤；传闻、仅洽谈、旧闻、少数股权投资和普通合作不享受例外。日报展示交易阶段及代币权益提示，沿用原群组和时间，不新增实时推送或恢复线上服务。来源核验、新颖性及范围限制继续有效；合成测试不证明 NOM 的具体交易事实。
- 审计修复记录见 [2026-09-12 审计及 2026-09-21 修复记录](docs/code-audit-2026-09-12.md)。代码验证不代表部署或真实消息送达，本次修复不恢复已停止的线上服务。
- 安全事件只接受有效来源链接、窗口内的来源发布时间及非低置信输入。跨来源合并需要同项目、同类型及相同事件时间或首次披露链接；信息不足时不做模糊合并。历史最大金额和最高等级保留，危急已发不降级补发。
- 市场确认使用接近一小时前的历史价格，不用日开盘价替代；仅取得备用现价、缺失小时历史或数据异常时继续 Fail-Closed。缺失行情显示“暂无可靠数据”，不转成零。
- 重大新闻来源必须通过 `BINANCE_MAJOR_NEWS_SOURCES_FILE` 指向的本地核验表。默认 `config/project_x_sources.json` 为空，未核验消息不纳入，未覆盖项目计入 partial，不能据此宣称没有重大消息。该表由人工依据独立证据维护，模型不能写入或自行认证。
- 核验表格式为 `{"SYMBOL":[{"account":"@verified_handle","role":"project_official","evidence_url":"https://project.example/team","verified_at":"2026-09-21T00:00:00Z"}]}`（仅格式示例，不能直接当作已核验来源）。角色允许 `project_official/founder/ceo/cto/cmo/core_team`；证据应能证明账号与该项目的关系，关系变动时更新表。

- 决定（2026-09-27，本轮剩余问题处理）：重大消息在每批付费 Hermes 调用之前核验来源。整批无独立核验账号时，保持原 universe/批次分母，记录 `partial + source_identity_unverified`、`searched_symbols=0`，不调用模型；部分有来源时只搜索已核验 symbol，结果只能归入该批已检索 symbol，原来源校验仍执行。全批跳过的日报明确“来源尚未核验，本轮未执行付费搜索，重大消息结果未知”，不能写成今日无重大消息或健康。该修复减少无效费用，**不代表空来源表或 Grok 额度恢复**；保留原配额断路、async送达链及安全 monitor 停用状态，不新增账号/供应商/调度。本轮候选57项定向测试通过，文案窄改后20项对应回归通过；生产重启与自然业务验收单独记录在当前交付证据。18:15因来源为空跳过时不能用它证明账户恢复，额度恢复仍须下一次原本有资格的自然调用证据（例如19:04机会任务）。
- 密钥只放 `.env`，不要提交到仓库。
- GDELT 有速率限制，过快轮询会出现 429。
- Massive/Finnhub 免费权限有限，系统已做主备容错和 Fail-Closed。
- GDELT 建议配置：
  - `GDELT_MIN_REQUEST_INTERVAL_SEC=10`
  - `GDELT_429_COOLDOWN_SEC=900`（命中 429 后冷却 15 分钟）
- X API 省钱模式：
  - 增量抓取（`since_id`）
  - 分批轮询白名单账号（round-robin）
  - 独立低频轮询间隔
  - 默认排除 retweets/replies
  - `x_user_cache` 持久化 user_id（重启后继续复用）
  - `x_since_cache` 持久化 since_id（重启后继续增量）
  - 说明：X API `max_results` 的最小值是 5，不能设为 2
- Telegram 发送模式：
  - `relay`：调用本地/内网 Telegram 服务（不需要 `TELEGRAM_BOT_TOKEN`）
  - `direct`：直接调用 Telegram Bot API（需要 `TELEGRAM_BOT_TOKEN`）

## PM2 生产启动
运行决定更新（2026-09-23）：用户要求停止漏洞黑客新闻检查，关闭 `SECURITY_INCIDENT_MONITOR_ENABLED`，替代 2026-09-21 恢复决定中的安全事件监控部分。机会采集及其他日报保持原配置；仅在用户明确要求恢复安全监控时重新启用。验收为运行状态 enabled=false、running=false、next_run_at=null，并同步 PM2 持久化。

运行决定更新（2026-09-21）：用户明确“恢复”，替代此前停止运行决定及本轮修复阶段“不恢复线上”的限制。已在现有 PM2 `ai-news` 实例加载当前代码并恢复安全事件监控；沿用端口 3117、安全轮询 1200 秒、机会日报 19:04 与重大消息日报 19:01。未启用原本关闭的宏观新闻/市场确认模块，未改变 Telegram 群组。PM2 持久化仅更新 ai-news 的安全开关，未保存其他项目状态。数据库迁移前已做 SQLite backup。必要验收区分进程/接口、首轮采集、来源覆盖及真实业务回执；官方账号核验表为空仍属于覆盖缺口，不以启动成功替代内容验收。后续有来源核验证据、当日日报到期或新告警时再核验相应业务链，不发送额外测试消息。

1. 安装 PM2
```bash
npm install -g pm2
```

2. 启动服务
```bash
npm run pm2:start
```

3. 查看状态与日志
```bash
npm run pm2:status
npm run pm2:logs
```

4. 重启/停止/删除
```bash
npm run pm2:restart
npm run pm2:stop
npm run pm2:delete
```

5. 开机自启（Windows/Linux 都建议做）
```bash
npm run pm2:save
npm run pm2:startup
```

## 控制台链接
- xAI Console: https://console.x.ai/
- X Developer Console: https://console.x.com/

## 业务消息交付证据

`GET /api/business-delivery` 是只读状态接口：仅查询 SQLite 与当前配置，不采集、不发送、不查询网关、不迁移或写库。返回最近应发日期的机会、Binance 重大消息、风险日报，以及最近 48 小时的风险／安全事件回执；不返回消息正文、chatId、凭据、幂等键或原始错误。

- `reports[].business_id` 将业务日期与分段回执关联；`expected_parts / recorded_parts / sent_parts` 区分完整日报与部分发送。
- `queued` 只表示网关接受；`sent` 必须有对应任务和 Telegram message ID。`failed`、`unknown`、`suppressed` 分别保留，不填成 sent。Gateway sent 不证明用户已阅读。
- 配置预检在采集/生成日报和占用日期前执行；disabled 不占日期，缺配置以 failed/configuration_missing 留证，未发出 POST，修复配置后允许首次提交。真正发送在 POST 前原子写入意图并带稳定幂等键。已有 queued/sent/unknown 或明确发送失败的同一业务 ID 不会自动重新 POST。
- 多段日报在首段提交前冻结完整消息、目标和分段清单，仅保存在本地 SQLite 内部。崩溃或首段 unknown 后，现有 tick 先对账；确认原段 queued/sent 后，只首发尚无提交意图的剩余段，不重新采集/生成内容。明确发送失败仍需针对该业务 ID 修复。最终 sent/suppressed 不会被较晚的超时或查询结果覆盖。
- 保留旧 `daily_reports.sent_at` 与推送标记，用于既有防重复与统计兼容；这些字段表示旧应用侧接受记录，不是网关最终回执。缺少关联回执的旧日报标为 `legacy_unverified`；最近 48 小时旧事件的应用推送标记若缺回执，也计入 legacy_event_unverified_count。均不修改历史记录，也不为补证据重发。
- 持久化最终回执沿现有日报检查 tick 执行，每轮最多 5 条只读网关查询、单条最多 3 秒；只对最近 48 小时的 queued/unknown 意图对账。超过该窗口保留历史未知记录，不无限轮询。没有新增调度器。
- 2026-09-27 交付修复：relay 提交显式采用 `mode=async`，避免客户端 5 秒提交超时先于网关同步等待完成；`queued` 后仍由原 tick 核对同键最终回执。首次提交未确认时仅记录业务 ID、HTTP 状态、固定错误分类和是否获得 JSON，不记录正文、目标、凭据或原始错误；后续对账不会抹掉日志中的原始提交证据。历史 unknown 不因此补发或改成 sent，真实验收沿下一次自然业务事件。
- `health.status=healthy` 要求已启用日报最近应发业务均为最终 sent/suppressed，且当前事件窗口无失败、未知或排队。未出现待验收事件/尚在排队为 waiting；旧日报缺凭证、缺段、失败、未知或超出生成宽限为 warning。宽限仅用于区分等待和逾期：机会日报按已配置 Hermes 超时 × 最大查询数 + 300 秒（至少 600 秒），其他日报为 30 分钟；waiting 与 warning 均不证明送达。
- 当前摘要只覆盖上述日期/48 小时窗口；超过 500 条的结果明确标 partial，不将截断当成全量健康。

2026-09-08 决定：优先复用现有 TelegramBot `/message-status?taskId=` 与 `/message-receipt?idempotencyKey=` 及当前日报 tick；新增 `notification_delivery`、`notification_batches` 两张追加表，历史业务表保留。验收以同业务 ID 的最终回执和只读接口为准；未发生新真实业务事件时，不额外发送测试消息。

2026-09-27 17:58:53 来源预检修复已定向加载到原 `ai-news` PM2 2，PID29678→8100；环境哈希保持、安全monitor仍false，重启前后Hermes active/queued均0，机会run358、重大消息run38、notification_batches38、notification_delivery48均未增加。57项源预检/配额定向回归、20项文案回归及最终3项账号类型边界通过。此项只完成节省调用修复，不代表来源表或账户恢复；不现场等18:15/19:04，沿用已有自然任务及回执跟进。证据：本工作流任务 `outputs/问题清单/evidence-20260927-all-closeout/ainews-source-preflight/`。
