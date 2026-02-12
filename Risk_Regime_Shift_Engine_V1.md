# Risk Regime Shift Engine V1
## 个人风险结构转折检测系统（V1 可执行规格）

## 1. 产品目标
本系统用于识别风险偏好结构转折（Risk-On -> Risk-Off），服务于你的个人资金管理，核心是给出对 Crypto 行情可能造成波动的高价值新闻预警，并结合市场结构确认后通过 Telegram 推送。

V1 的目标不是“收集更多新闻”，而是“降低误报、稳定运行、可持续优化”。

## 2. 用户已确认的业务决策
1. 资产优先级：Crypto 为主，美股/黄金/DXY 为辅助确认。
2. 必须包含市场确认层。
3. 接入指定 X 白名单账号（先 5-10 个，逐步扩展）。
4. 优化目标偏向“降低误报”。
5. 推送频率偏好：中等。
6. 推送语言：中文。
7. V1 必须提供 `/status.json` 风险状态面板。
8. 时效目标：新闻发布时间到 Telegram 推送 <= 5 分钟（尽最大努力）。
9. Level 2 默认开启。
10. Level 3 每日上限 3 条。
11. 同一事件去重窗口 60 分钟。
12. 数据源异常策略：Fail-Closed。
13. Level 2 冷却时间 90 分钟。
14. 推送建议粒度：资产层建议（Alt/BTC/稳定币方向）。
15. 行情源策略：混合模式（中心化 API + perp DEX API + TradingView 告警补充）。
16. `regime_probability` 使用规则映射（V1 不上训练模型）。

## 3. V1 范围与非范围
### 3.1 V1 范围（必须实现）
1. 新闻采集：RSS + GDELT + X 白名单账号流。
2. LLM 结构化解析：严格 JSON 输出，禁止自由文本。
3. 市场确认：BTC、美股代理、黄金、DXY。
4. 风险引擎：统一 RiskScore、分级、推送决策。
5. Telegram 通知：分级推送、冷却与去重。
6. 状态面板：HTTP `/status.json`。
7. 可追溯存储：SQLite（必须）。
8. 运行方式：VPS 24x7，Node.js 纯 JavaScript。

### 3.2 V1 非范围（放到后续）
1. 自动交易或自动对冲。
2. 精细仓位比例建议。
3. 跨资产复杂相关性建模（机器学习版）。
4. 全网爬虫、群聊高噪声数据接入。

## 4. 总体架构
系统分为五个模块：
1. Collector（采集层）：采集并标准化事件。
2. LLM Analyzer（语义层）：输出事件结构化标签与严重度。
3. Market Module（市场层）：计算市场确认分与异常状态。
4. Risk Engine（决策层）：统一评分、分级、去重、冷却、推送条件判定。
5. Notifier + Status API（输出层）：Telegram 推送与 `/status.json` 输出。

所有模块必须故障隔离，不阻塞主循环。

## 5. 数据源与优先级
### 5.1 新闻数据
1. GDELT：宏观与地缘风险事件补充源。
2. RSS：官方机构与一线媒体源。
3. X：仅白名单账号，不跑全网关键词流。

### 5.2 X 白名单（首批）
1. `@zoomerfied`
2. `@bwenews`
3. `@realDonaldTrump`
4. `@CNBC`
5. `@unusual_whales`
6. `@KobeissiLetter`
7. `@financialjuice`

说明：V1 默认只使用这批账号，后续按误报率评估扩容。

### 5.3 行情数据源策略（混合）
1. 使用混合源，目标是“稳定优先 + 成本可控”。
2. 每个关键资产至少配置 2 个来源（主源 + 备源）。
3. 可用来源类型：
- 中心化交易所/指数 API（稳定主源）。
- perp DEX API（黄金/DXY/部分美股代理可作为补充或备源）。
- TradingView 告警（Webhook）作为补充信号，不直接替代原始行情源。
4. 数据选用原则：
- 优先使用最新且未过期的数据。
- 主源失败自动切换备源。
- 主备同时可用时，优先主源；若偏差过大则标记异常并触发 Fail-Closed 规则。

### 5.4 已选主源/备源（V1）
1. BTC
- 主源：Binance `GET /api/v3/ticker/price?symbol=BTCUSDT`
- 备源：Coinbase `GET /v2/prices/BTC-USD/spot`
2. 美股代理（SPX/QQQ）
- 主源：Massive (Polygon) Indices/Equities API（`I:SPX`、`QQQ`）
- 备源：Finnhub（SPY/QQQ 作为指数代理）
3. 黄金代理（XAUUSD）
- 主源：Binance `GET /api/v3/ticker/price?symbol=PAXGUSDT`
- 备源：Coinbase `GET /v2/prices/PAXG-USD/spot`
4. DXY
- 主源：Finnhub（USD 指数相关接口）
- 备源：TradingView Alert（仅补充，不直接作为原始价格）

说明：
1. 所有第三方密钥仅存放在 `.env`，不得写入代码和文档正文。
2. 若主备源单位或市场时段不同，需在 `Market Module` 做统一标准化后再计算。
3. `ticker/spot` 端点仅用于最新价快照；1h 变动和波动指标必须使用 K 线/聚合历史端点计算。

## 6. 市场确认逻辑（V1）
覆盖资产：BTC、美股指数代理（如 SPX 或 QQQ 代理）、黄金（XAUUSD）、DXY。

输入要求：
1. 每个资产读取主源，失败时自动切换备源。
2. 若 TradingView 告警与市场方向一致，可作为附加置信度证据写入 `anomaly_reasons/decision_reasons`，不单独加分。

建议的确认子项与权重（总分 100）：
1. BTC 1h 跌幅阈值触发（如 <= -2%）或 4h 结构破位：+30。
2. 美股风险代理 1h 跌幅触发（如 <= -1%）：+20。
3. 黄金 1h 上涨 >= +0.4%，且与风险资产反向：+20。
4. DXY 1h 上涨 >= +0.2%，且与风险资产反向：+20。
5. 波动率放大（短窗波动显著高于基线）：+10。

`MarketConfirmation` 取 0-100。

## 7. 数据源异常定义与 Fail-Closed 规则
### 7.1 数据源异常定义
满足任一条件即视为异常：
1. 任一关键行情接口请求失败或超时。
2. 关键行情数据过旧（滞后超过 `MARKET_STALE_SECONDS`，默认 180 秒）。
3. BTC/美股代理/黄金/DXY 中缺失 1 项及以上。
4. 当前轮市场确认分无法完整计算。
5. 同一资产主备源价格偏差超过 `MAX_CROSS_SOURCE_BPS_DIFF`（默认 80 bps）。

### 7.2 Fail-Closed 规则
1. 发生市场数据异常时，禁止发 Level 3。
2. 允许降级到 Level 2，但推送中必须标注“市场确认不足，已降级”。
3. 连续异常时继续记录事件与评分，不中断系统主循环。

## 8. 风险评分模型
使用半结构化评分，不使用纯黑盒。

`RiskScore = NewsSeverity * 0.30 + AssetRelevance * 0.15 + MarketConfirmation * 0.40 + SourceCredibility * 0.15`

评分字段说明：
1. `NewsSeverity`：LLM 输出，0-100。
2. `AssetRelevance`：LLM 输出，0-100。
3. `MarketConfirmation`：规则计算，0-100。
4. `SourceCredibility`：来源可信度映射，0-100。

来源可信度分层：
1. 官方机构：90-100。
2. 一线媒体：75-90。
3. 普通媒体：60-75。
4. X 白名单账号：65-85。
5. 普通社媒：30-60（V1 不主动接入）。

## 9. LLM 输出契约（必须严格 JSON）
```json
{
  "event_type": "",
  "news_severity": 0,
  "asset_relevance": 0,
  "assets": [],
  "direction_hint": {},
  "time_horizon": "",
  "reasons": [],
  "unknowns": []
}
```

约束：
1. 不允许附加自然语言段落。
2. `reasons` 目标 3 条，供推送解释。
3. JSON 解析失败时，该事件标记 `llm_invalid=true`，仅入库不推送。

## 10. 风险分级、去重与冷却
### 10.1 分级规则
1. Level 1（解释级）：`RiskScore 40-59`，仅入面板不推送。
2. Level 2（趋势预警）：`RiskScore 60-74`，默认开启推送。
3. Level 3（结构转折）：`RiskScore >= 75` 且 `MarketConfirmation >= 70`。

### 10.2 推送约束
1. Level 3 每日上限：3 条。
2. 同一事件去重窗口：60 分钟。
3. Level 2 冷却时间：90 分钟。
4. 异常模式下禁止 Level 3（Fail-Closed）。

## 11. Telegram 推送内容（中文）
每条推送必须包含：
1. 风险等级（Level 2/3）。
2. `RiskScore` 与 `MarketConfirmation`。
3. 事件摘要（1-2 句）。
4. 来源与链接。
5. 风险解读（3 条 reasons）。
6. 资产层方向建议（如“降低 Alt 暴露，提高 BTC/稳定币占比”）。
7. 若降级触发，显示“市场确认不足，按 Level 2 推送”。

明确限制：不输出具体仓位百分比，不构成投资建议。

## 12. 状态面板接口
`GET /status.json`

```json
{
  "regime": "Risk-On | Neutral | Risk-Off",
  "regime_probability": 0,
  "risk_score": 0,
  "market_confirmation": 0,
  "latest_events": []
}
```

要求：
1. 更新频率 1-3 分钟。
2. `latest_events` 保留最近高分事件。
3. 字段值与推送逻辑保持一致。

`regime_probability` 规则映射（V1）：
1. `regime_probability = clamp(round(0.55 * risk_score + 0.45 * market_confirmation), 0, 100)`。
2. 若 `is_data_anomaly=true`，则 `regime_probability = min(regime_probability, 69)`（异常时不进入 Risk-Off）。
3. `regime` 映射：
- `regime_probability >= 70` -> `Risk-Off`
- `40 <= regime_probability <= 69` -> `Neutral`
- `regime_probability < 40` -> `Risk-On`

## 13. 存储与可追溯
数据库：SQLite（V1 强制）。

建议数据表：
1. `events`
2. `scores`
3. `market_snapshots`
4. `push_logs`
5. `system_health`

最低落库字段：
1. `event_id`
2. `timestamp`
3. `publish_time`
4. `ingest_time`
5. `risk_score`
6. `level`
7. `market_confirmation`
8. `push_flag`
9. `push_reason`
10. `latency_publish_to_push_sec`

要求：保留至少 30 天历史，用于参数打磨与误报复盘。

## 14. 配置项（.env）
```env
POLL_INTERVAL_SEC=180
LEVEL2_THRESHOLD=60
LEVEL3_THRESHOLD=75
MARKET_CONFIRM_STRONG=70
LEVEL3_DAILY_LIMIT=3
DEDUP_WINDOW_MIN=60
LEVEL2_COOLDOWN_MIN=90
ENABLE_MARKET_CONFIRMATION=true
ENABLE_X_SOURCE=true
MARKET_SOURCE_MODE=mixed
MARKET_STALE_SECONDS=180
MAX_CROSS_SOURCE_BPS_DIFF=80
LATENCY_TARGET_SEC=300
ENABLE_TRADINGVIEW_WEBHOOK=true
TRADINGVIEW_WEBHOOK_SECRET=
BINANCE_BASE_URL=https://api.binance.com
COINBASE_BASE_URL=https://api.coinbase.com
MASSIVE_API_KEY=
FINNHUB_API_KEY=
MARKET_PROXY_EQUITY_PRIMARY=I:SPX,QQQ
MARKET_PROXY_EQUITY_BACKUP=SPY,QQQ
KEYWORDS_FILE=./config/keywords.txt
X_WHITELIST_FILE=./config/x_whitelist.txt
TELEGRAM_ENABLED=true
TELEGRAM_CHAT_ID=
TELEGRAM_BOT_TOKEN=
```

## 15. 模块接口契约
### 15.1 Collector 输出
```json
{
  "id": "",
  "title": "",
  "source": "",
  "source_type": "rss|gdelt|x",
  "timestamp": "",
  "publish_time": "",
  "url": "",
  "raw_text": ""
}
```

### 15.2 Market Module 输出
```json
{
  "btc_change_1h": 0,
  "equities_change_1h": 0,
  "gold_change_1h": 0,
  "dxy_change_1h": 0,
  "confirmation_score": 0,
  "is_data_anomaly": false,
  "anomaly_reasons": []
}
```

### 15.3 Risk Engine 输出
```json
{
  "risk_score": 0,
  "level": 0,
  "regime": "",
  "push_allowed": false,
  "decision_reasons": []
}
```

## 16. 时效目标与验收口径
### 16.1 时效目标
1. 目标口径：`publish_time -> telegram_push_time <= 300 秒`。
2. 由于外部源发布时间与抓取可见性存在天然延迟，系统需分别统计：
- `publish_time -> ingest_time`
- `ingest_time -> push_time`
3. 内部链路硬约束：`ingest_time -> push_time <= 300 秒`。

### 16.2 验收标准（V1）
1. VPS 24x7 稳定运行。
2. Level 3 推送少而精，日上限生效。
3. 误报可复盘，所有事件可追溯。
4. `/status.json` 实时可访问。
5. 数据源异常时 Fail-Closed 生效。
6. 推送均可解释（含 reasons）。

## 17. 版本规划
1. V1：本文件全部条目。
2. V1.5：事件去重增强、参数自动调优、双模型复核。
3. V2：自动对冲建议与跨资产增强逻辑。

## 18. 核心原则
1. 结构性风险优先于短期噪声。
2. 必须结合市场确认。
3. 稳健优先于激进。
4. 输出必须可解释、可追溯。
5. 先稳定可用，再迭代增强。
