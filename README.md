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
- `health.status=healthy` 要求已启用日报最近应发业务均为最终 sent/suppressed，且当前事件窗口无失败、未知或排队。未出现待验收事件/尚在排队为 waiting；旧日报缺凭证、缺段、失败、未知或超出生成宽限为 warning。宽限仅用于区分等待和逾期：机会日报按已配置 Hermes 超时 × 最大查询数 + 300 秒（至少 600 秒），其他日报为 30 分钟；waiting 与 warning 均不证明送达。
- 当前摘要只覆盖上述日期/48 小时窗口；超过 500 条的结果明确标 partial，不将截断当成全量健康。

2026-09-08 决定：优先复用现有 TelegramBot `/message-status?taskId=` 与 `/message-receipt?idempotencyKey=` 及当前日报 tick；新增 `notification_delivery`、`notification_batches` 两张追加表，历史业务表保留。验收以同业务 ID 的最终回执和只读接口为准；未发生新真实业务事件时，不额外发送测试消息。
