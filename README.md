# AI News Risk Engine (V1)

Crypto 风险新闻辅助系统：采集宏观/地缘新闻，结合市场确认，计算风险分级并推送 Telegram。

## 已实现模块
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
- `DAILY_REPORT_ENABLED=true`
- `DAILY_REPORT_TIME_BJ=16:43`
- `DAILY_REPORT_CHECK_INTERVAL_SEC=30`
- `DAILY_REPORT_MAX_EVENTS=5`
- `DAILY_REPORT_MESSAGE_MAX_CHARS=1200`
- `OPPORTUNITY_MONITOR_ENABLED=true`
- `OPPORTUNITY_INTERVAL_SEC=900`
- `OPPORTUNITY_HERMES_BIN=hermes`
- `OPPORTUNITY_HERMES_PROFILE=xintel`
- `OPPORTUNITY_HERMES_TIMEOUT_SEC=240`
- `OPPORTUNITY_LOOKBACK_HOURS=72`
- `OPPORTUNITY_STALE_AFTER_HOURS=96`
- `OPPORTUNITY_MAX_FOLLOWUPS=3`
- `OPPORTUNITY_FOCUSED_QUERIES_ENABLED=true`（额外执行 Gate/SpaceX 和链上/DEX 专题查询，减少主查询漏项）
- `OPPORTUNITY_QUERY_MATRIX_ENABLED=true`（按 CEX × 类别拆分专题查询）
- `OPPORTUNITY_ADAPTIVE_QUERY_PLAN_ENABLED=true`（主查询超时后，下一轮自动降级为更小的专题查询）
- `OPPORTUNITY_MAX_QUERY_JOBS=5`（每轮最多执行的 xintel 查询数，防止 15 分钟任务重叠）
- `OPPORTUNITY_ENRICHMENT_ENABLED=true`（搜索后补全官方公告链接和截止时间）
- `OPPORTUNITY_ENRICHMENT_MAX_ITEMS=5`
- `OPPORTUNITY_EXISTING_ENRICHMENT_MAX_ITEMS=2`（每轮额外补查旧机会的官方链接/截止信息）
- `OPPORTUNITY_ENRICHMENT_RETRY_COOLDOWN_HOURS=12`（补查无结果后多久再重试）
- `OPPORTUNITY_OFFICIAL_CRAWL_TIMEOUT_SEC=15`
- `OPPORTUNITY_GROK_DEADLINE_FALLBACK_ENABLED=true`
- `OPPORTUNITY_GROK_DEADLINE_FALLBACK_MAX=2`
- `SUPPRESS_KEYWORDS_FILE=./config/suppress_keywords.txt`
- `ENABLE_TRADINGVIEW_WEBHOOK=true`
- `TRADINGVIEW_WEBHOOK_SECRET=[REDACTED]`（启用 TradingView webhook 时必须配置；为空或未配置会 fail-closed 拒绝请求，返回 `webhook_secret_missing`）

## 接口
- `GET /status.json`
- `GET /health`
- `GET /opportunities`（xintel/Grok 高收益机会监控网页）
- `GET /api/opportunities`
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
