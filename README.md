# AI News Risk Engine (V1)

Crypto 风险新闻辅助系统：采集宏观/地缘新闻，结合市场确认，计算风险分级并推送 Telegram。

## 已实现模块
- Collector: RSS + GDELT + X 白名单
- Analyzer: AI 可配置（Grok/Gemini）结构化 JSON（失败自动降级到启发式）
- Market: BTC / 美股代理 / 黄金 / DXY(代理) 的主备源与异常检测
- Risk Engine: RiskScore、分级、Fail-Closed、去重与冷却
- Notifier: Telegram 中文推送
- API: `GET /status.json`, `GET /health`, `POST /webhook/tradingview`
- Storage: SQLite 持久化 (`events/scores/market_snapshots/push_logs/system_health`)

## 快速开始
1. 安装依赖
```bash
npm install
```

2. 复制环境变量模板
```bash
copy .env.example .env
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
- `MASSIVE_API_KEY`
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
- `LEVEL3_THRESHOLD=75`
- `MARKET_CONFIRM_STRONG=70`
- `LEVEL3_DAILY_LIMIT=3`
- `DEDUP_WINDOW_MIN=60`
- `LEVEL2_COOLDOWN_MIN=90`
- `NEWS_LOOKBACK_MIN=120`
- `AI_PROVIDER=grok`
- `AI_MODEL=grok-3-latest`
- `EQUITIES_PRIMARY_SOURCE=finnhub`
- `USE_MARKET_HOURS_STALE_GUARD=true`
- `US_MARKET_CLOSED_STALE_SECONDS=259200`
- `X_MIN_REQUEST_INTERVAL_SEC=300`
- `X_USERS_PER_CYCLE=3`
- `X_MAX_RESULTS_PER_USER=5`
- `X_EXCLUDE_RETWEETS_REPLIES=true`
- `TELEGRAM_MODE=relay`
- `TELEGRAM_SERVICE_URL=http://127.0.0.1:3000`
- `TELEGRAM_API_KEY=...`

## 接口
- `GET /status.json`
- `GET /health`
- `POST /webhook/tradingview`
  - Header: `x-tradingview-secret: <TRADINGVIEW_WEBHOOK_SECRET>`
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
pm2 save
pm2 startup
```

## 控制台链接
- xAI Console: https://console.x.ai/
- X Developer Console: https://console.x.com/


