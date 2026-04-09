# 风险预警推送优化 + 每日轻量总结（强降本版）

## 版本：V1.1
## 创建日期：2026-04-09
## 状态：待开发

---

## 1. 需求背景

当前 V1 系统已能完成实时风险预警与统计型日报，但存在三类问题：
1. 推送可读性不足：事件标题和风险解读存在英文输出。
2. 操作建议不够具体：缺少面向具体资产的方向建议。
3. LLM 成本偏高风险：原方案包含 7 天历史事件线程分析，token 消耗过大。

---

## 2. 目标定义

### 2.1 实时推送优化
- 事件标题优先中文（`title_zh`），缺失时回退原标题。
- 风险解读仅保留中文短句，最多 2 条。
- 操作建议采用 `asset_actions`，每条推送仅保留 1-3 个最相关资产。
- 不提供具体价格点位。
- 不保留投资免责声明文案。

### 2.2 每日轻量总结（替代深度历史版）
- 发送时间：北京时间每日 `16:43`。
- 统计窗口：北京时间当日 `00:00` 到发送时刻。
- 内容目标：当日风险态势、Regime 简析、核心风险点、1-3 条资产建议、后续关注点。
- 明确取消：7 天历史事件追踪、时间线串联、历史线程演化分析。

---

## 3. 关键设计

### 3.1 分析链路：`heuristic-first` 强降本
仅满足以下条件才调用 LLM：
1. `news_severity >= 55`；
2. 或 `asset_relevance >= 55`；
3. 或 `source_type = x`；
4. 或命中地缘/政策强关键词。

未命中时，直接使用 heuristic 结果，不调用 LLM。

### 3.2 实时分析输出契约（瘦身后）
```json
{
  "event_type": "",
  "title_zh": "",
  "news_severity": 0,
  "asset_relevance": 0,
  "reasons": [],
  "asset_actions": [
    {
      "asset": "BTC",
      "action": "减仓",
      "confidence": "high",
      "rationale": "地缘风险抬升，短期波动放大。"
    }
  ]
}
```

约束：
- `reasons` 最多 2 条。
- `asset_actions` 1-3 条。
- `action` 枚举：`买入` / `卖出` / `减仓` / `加仓` / `持有` / `观望`。
- 删除旧字段：`assets`、`direction_hint`、`time_horizon`、`unknowns`。

### 3.3 LLM 输入裁剪
实时分析 prompt 不再传完整事件对象，仅传：
- `title`
- `source`
- `source_type`
- `publish_time`
- 截断后的 `raw_text`

默认截断：`AI_EVENT_RAW_TEXT_MAX_CHARS=500`。

### 3.4 每日轻量总结输出结构
```json
{
  "summary_title": "当日风险态势轻量总结",
  "regime_summary": "...",
  "key_risks": ["..."],
  "asset_outlook": [{"asset": "BTC", "action": "观望", "rationale": "..."}],
  "risk_watch": ["..."],
  "overall_assessment": "..."
}
```

约束：
- `key_risks` 最多 3 条。
- `asset_outlook` 最多 3 条。
- `risk_watch` 最多 2 条。
- 单条日报消息目标长度 `<= 1200` 字符；超长时先裁剪 `asset_outlook`，再裁剪 `risk_watch`。

---

## 4. 配置项

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `DAILY_REPORT_TIME_BJ` | `16:43` | 日报发送时间 |
| `DAILY_REPORT_MAX_EVENTS` | `5` | 日报输入事件上限 |
| `DAILY_REPORT_MESSAGE_MAX_CHARS` | `1200` | 日报目标消息长度 |
| `AI_LLM_CANDIDATE_MIN_SCORE` | `55` | LLM 预筛选阈值 |
| `AI_EVENT_RAW_TEXT_MAX_CHARS` | `500` | 实时分析原文截断长度 |

废弃：
- `DAILY_REPORT_LOOKBACK_DAYS`（取消 7 天历史回溯方案）。

---

## 5. 涉及文件

- `src/analyzer/aiAnalyzer.js`
- `src/notifier/telegram.js`
- `src/pipeline.js`
- `src/db.js`
- `src/config.js`
- `.env.example`

---

## 6. 验收标准

1. 实时推送事件标题默认中文；风险解读中文且不超过 2 条。
2. 实时推送包含 1-3 条具体资产操作建议，无价格点位。
3. 实时推送不拼接投资免责声明。
4. 低风险普通事件多数不调用 LLM（走 heuristic）。
5. 每日 16:43 自动发送轻量总结，不含 7 天历史事件分析。
6. 日报 LLM 失败时回退统计版，不中断发送。
7. Level 2/3 分级、去重、冷却、降级逻辑保持不变。
