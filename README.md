# AI News Risk Engine (V1)

Crypto 椋庨櫓鏂伴椈杈呭姪绯荤粺锛氶噰闆嗗畯瑙?鍦扮紭鏂伴椈锛岀粨鍚堝競鍦虹‘璁わ紝璁＄畻椋庨櫓鍒嗙骇骞舵帹閫?Telegram銆?
## 宸插疄鐜版ā鍧?- Collector: RSS + GDELT + X 鐧藉悕鍗?- Analyzer: AI 鍙厤缃紙Grok/Gemini锛夌粨鏋勫寲 JSON锛堝け璐ヨ嚜鍔ㄩ檷绾у埌鍚彂寮忥級
- Market: BTC / 缇庤偂浠ｇ悊 / 榛勯噾 / DXY(浠ｇ悊) 鐨勪富澶囨簮涓庡紓甯告娴?- Risk Engine: RiskScore銆佸垎绾с€丗ail-Closed銆佸幓閲嶄笌鍐峰嵈
- Notifier: Telegram 涓枃鎺ㄩ€?- API: `GET /status.json`, `GET /health`, `POST /webhook/tradingview`
- Storage: SQLite 鎸佷箙鍖?(`events/scores/market_snapshots/push_logs/system_health`)

## 蹇€熷紑濮?1. 瀹夎渚濊禆
```bash
npm install
```

2. 澶嶅埗鐜鍙橀噺妯℃澘
```bash
copy .env.example .env
```

3. 濉啓 `.env`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_MODE=relay`
- `APP_PORT`锛堜緥濡?`3100`锛岄伩鍏嶄笌 Telegram 鏈嶅姟绔彛鍐茬獊锛?- `TELEGRAM_SERVICE_URL`锛堜緥濡?`http://127.0.0.1:3000`锛?- `TELEGRAM_API_KEY`
- `AI_PROVIDER`锛坄grok` 鎴?`gemini`锛?- `AI_API_KEY`
- `AI_MODEL`
- `MASSIVE_API_KEY`
- `FINNHUB_API_KEY`
- `X_BEARER_TOKEN`锛堝闇€ X锛?
4. 鍚姩
```bash
npm start
```

## 鍏抽敭閰嶇疆
- `POLL_INTERVAL_SEC=180`
- `APP_PORT=3100`
- `LEVEL2_THRESHOLD=50`
- `X_LEVEL2_THRESHOLD_LOWER_FOR_X=10`
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

## 鎺ュ彛
- `GET /status.json`
- `GET /health`
- `POST /webhook/tradingview`
  - Header: `x-tradingview-secret: <TRADINGVIEW_WEBHOOK_SECRET>`
  - Body 绀轰緥锛?```json
{
  "symbol": "BTCUSDT",
  "direction": "risk_off",
  "note": "breakdown"
}
```

## 娉ㄦ剰
- 瀵嗛挜鍙斁 `.env`锛屼笉瑕佹彁浜ゅ埌浠撳簱銆?- GDELT 鏈夐€熺巼闄愬埗锛岃繃蹇疆璇細鍑虹幇 429銆?- Massive/Finnhub 鍏嶈垂鏉冮檺鏈夐檺锛岀郴缁熷凡鍋氫富澶囧閿欏拰 Fail-Closed銆?- GDELT 寤鸿閰嶇疆锛?  - `GDELT_MIN_REQUEST_INTERVAL_SEC=10`
  - `GDELT_429_COOLDOWN_SEC=900`锛堝懡涓?429 鍚庡喎鍗?15 鍒嗛挓锛?- X API 鐪侀挶妯″紡锛?  - 澧為噺鎶撳彇锛坄since_id`锛?  - 鍒嗘壒杞鐧藉悕鍗曡处鍙凤紙round-robin锛?  - 鐙珛浣庨杞闂撮殧
  - 榛樿鎺掗櫎 retweets/replies
  - `x_user_cache` 鎸佷箙鍖?user_id锛堥噸鍚悗缁х画澶嶇敤锛?  - `x_since_cache` 鎸佷箙鍖?since_id锛堥噸鍚悗缁х画澧為噺锛?  - 璇存槑锛歑 API `max_results` 鐨勬渶灏忓€兼槸 5锛屼笉鑳借涓?2
- Telegram 鍙戦€佹ā寮忥細
  - `relay`锛氳皟鐢ㄦ湰鍦?鍐呯綉 Telegram 鏈嶅姟锛堜笉闇€瑕?`TELEGRAM_BOT_TOKEN`锛?  - `direct`锛氱洿鎺ヨ皟鐢?Telegram Bot API锛堥渶瑕?`TELEGRAM_BOT_TOKEN`锛?
## PM2 鐢熶骇鍚姩
1. 瀹夎 PM2
```bash
npm install -g pm2
```

2. 鍚姩鏈嶅姟
```bash
npm run pm2:start
```

3. 鏌ョ湅鐘舵€佷笌鏃ュ織
```bash
npm run pm2:status
npm run pm2:logs
```

4. 閲嶅惎/鍋滄/鍒犻櫎
```bash
npm run pm2:restart
npm run pm2:stop
npm run pm2:delete
```

5. 寮€鏈鸿嚜鍚紙Windows/Linux 閮藉缓璁仛锛?```bash
pm2 save
pm2 startup
```

## 鎺у埗鍙伴摼鎺?- xAI Console: https://console.x.ai/
- X Developer Console: https://console.x.com/



