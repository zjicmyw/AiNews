# AiNews 工作入口

按本次任务选择入口：不清楚位置时查 [README](README.md)；风险引擎或提醒需求变更查对应的 [风险引擎规格](docs/Risk_Regime_Shift_Engine_V1.md) 或 [风险提醒增强](docs/risk-alert-enhancement-v1.1.md)，并核对相关配置和实现。已知位置的局部编辑只读相关上下文，无需先读完整 README。README 的示例端口、时间与参数不自动等于实际运行值。

- 内容纳入、排除、截止时间与展示窗口沿有效需求和机会监控实现维护；变更规则时同步采集/过滤、API、页面、日报及相关测试中真正受影响的部分。
- 分别验证采集 run、内容生成、新鲜度、日报应发条件和消息最终状态。最近 run 成功不能代替今日内容已生成或已发送。
- 沿同一日报日期/业务 ID 关联 Worker 与发送证据。网关接受或本地 success 字段不足以证明最终投递时，明确写未检查/部分覆盖；没有应发事件不是发送失败。
- 检查复用当前 GET 状态接口和无副作用的项目工具；修复继承已授权范围，避免为验收额外触发采集、付费模型请求或真实推送。

重大决定记录在相关现有说明：`决定｜适用范围｜来源与日期｜替代了什么｜必要验收｜下次重开条件`。不新增第二套日报或巡检调度。

## Local Resource Admission

On this Mac, when /Users/easthash/.codex/skills/local-resource-guard exists,
route memory-heavy builds, test suites, browser checks, and batch research
through its scripts/workflow.py (project ID: ai-news; plan before run).
Read that Skill for peak-memory estimates, current pressure, and receipt checks.
Ordinary editing and bounded lightweight checks are not limited by task count.
A deferred run is not a passed test. Do not bypass denial or stop other tasks.
Existing research freezes, external-action permissions, and paused services remain
in force. This local integration does not change CI, cloud, or production commands.
