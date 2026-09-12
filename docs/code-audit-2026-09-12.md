# AiNews 代码审计（2026-09-12）

## 结论与范围

确认 17 项可复现问题：7 项 P1、10 项 P2。现有测试通过不等于下列边界已经满足要求。

审查基线为 `5eaa15a230101e3f6b138f512357a84db56f971c` 加当前工作区。纳入原有未提交的 `ecosystem.config.cjs`、`package.json`、`src/opportunityMonitor.js`、`test/opportunityMonitor.test.js` 和未跟踪的 `scripts/recover-opportunity-run.js`。A01 的提前返回问题来自当前恢复查询改动；其余问题已存在于本轮读取的完整实现中。

范围覆盖采集、Hermes 调度、解析和补全、安全事件与风险评分、SQLite 去重与通知回执、日报生成、HTTP API 与页面输出路径。依据当前 README、配置、实现及对话中的有效业务要求审查，不把最初的 10 分钟要求或旧规格的 16:43 自动当作当前配置。当前 README 与配置声明的安全监控默认周期为 1200 秒、机会日报为 19:04；本次没有读取或改变生产进程环境。

本次为审计，未修复业务代码，未启动、停止或重启线上服务，未调用真实 Hermes、交易所、PostgreSQL 或 Telegram 服务。新增本报告；复现脚本及测试日志保存在临时目录。没有交易或钱包操作。

## 验证结果

- `npm test`：155/155 通过。首次沙箱运行的 HTTP 用例因 `listen EPERM` 失败；允许临时本地测试端口后全量通过。
- `npm run check`：通过。该命令原本只检查 `src/index.js`，另对 `src`、`scripts` 和 PM2 配置执行逐文件语法检查。
- `git diff --check`：通过。
- [独立复现脚本](/private/tmp/ainews-strict-audit-repro.mjs)：17/17 用例复现当前缺陷。注意：这些断言验证的是错误行为确实存在，不是修复后的业务验收测试。
- [全量测试日志](/private/tmp/ainews-strict-audit-tests.log)、[缺陷复现日志](/private/tmp/ainews-strict-audit-repro.log)。

```bash
node --test /private/tmp/ainews-strict-audit-repro.mjs
```

复现全部采用 mock、内存 SQLite 或纯函数调用。没有证明线上已发生这些故障，也未做真实攻击利用、依赖 CVE 情报扫描或浏览器交互验收。

## P1：优先修复

### A09：官方页面抓取可绕过内网访问限制

位置：[opportunityEnrichment.js:234](/Users/easthash/code/AiNews/src/opportunityEnrichment.js:234)、[opportunityEnrichment.js:579](/Users/easthash/code/AiNews/src/opportunityEnrichment.js:579)。

`isPrivateHostname` 只覆盖部分 IPv4 范围，未正确识别 URL 解析后带方括号的 IPv6；`https://127.0.0.2/`、`https://[::1]/`、`https://[fd00::1]/` 均被判为公网 HTTPS。爬虫还对通过首跳检查的 URL 使用 `redirect: "follow"`，不校验跳转目标或最终 URL。链上项目的候选链接来自模型输出，可进入该抓取路径，造成 SSRF。

复现：上述三个私网地址均返回 `true`；模拟最终跳到 `http://127.0.0.1:3000/private` 时仍返回成功页面。未请求真实内网。

修复与验收：统一验证协议、地址范围和 DNS 解析结果，逐跳检查重定向并限制跳数，避免解析与连接间的地址切换；补 IPv4/IPv6 回环、私网、链路本地及跳转测试。

### A07：降级风险告警绕过已计算的冷却和去重拒绝

位置：[pipeline.js:673](/Users/easthash/code/AiNews/src/pipeline.js:673)、[riskEngine.js:59](/Users/easthash/code/AiNews/src/riskEngine.js:59)。

`if (!scoreResult.push_allowed && !degraded)` 仅在未降级时执行禁止发送。原本达到 Level 3、因行情异常降为 Level 2 的消息，即使引擎已给出 `level2_cooldown_block` 或 `dedup_window_block`，仍会进入通知发送。不同事件有不同通知 business ID，通知幂等不能补上全局冷却限制。

复现：使用真实 `RiskEngine.evaluate()` 得到 `push_allowed=false`、`push_reason=level2_cooldown_block`，随后 `processEvent()` 仍调用一次 notifier。

修复与验收：降级只改变等级与文案，最终发送仍必须服从统一推送决策；分别验证降级情况下的冷却与同标题去重，不可恢复成可发送。

### A13：关键行情数值缺失时 Fail-Closed 未生效

位置：[market/index.js:373](/Users/easthash/code/AiNews/src/market/index.js:373)。

异常检测只检查资产对象是否存在和时间是否过旧，没有检查 `change1hPct` 等计算必需字段。对象存在但涨跌幅为 `null` 时，确认分会跳过该子项，仍被标为非异常。BTC、美股、DXY 和波动项可累计到 80 分，此时满足 Level 3 的市场门槛，违背缺失关键行情必须降级的要求。

复现：黄金 `change1hPct=null`，输出 `gold_change_1h=null`、`confirmation_score=80`、`is_data_anomaly=false`。

修复与验收：定义每种资产的有效数据契约，对缺失、非有限数值、不可用历史基准标记异常；逐个移除关键输入后都必须禁止 Level 3。

### A05：合并后的金额和证据已满足危急条件，却不会升级补发

位置：[securityIncidentMonitor.js:307](/Users/easthash/code/AiNews/src/securityIncidentMonitor.js:307)、[db.js:734](/Users/easthash/code/AiNews/src/db.js:734)。

数据库分别保留历史最大金额、最高证据分，但 `alert_level` 只取各次输入等级的最大值，未按合并后的有效数据重新分类。先收到大额但中分的异常消息，随后收到高分但未重复金额的确认消息时，两次输入都为 anomaly，历史异常推送标记便阻止后续发送。

复现：第一条 600 万美元、55 分；第二条金额未知、95 分。同来源合并后数据库是 600 万美元、95 分，但等级仍为 anomaly，危急推送为空；对合并行直接调用分类器却返回 critical。

修复与验收：以可归属于同一事件的合并数据重新计算有效等级并持久化，再决定升级推送；保留既定不降级规则。验收需覆盖金额和证据分分别在不同轮次补齐的情况。

### A04：安全事件以来源 URL 单独去重，会合并不同项目并重复推送同一事件

位置：[securityIncidentMonitor.js:106](/Users/easthash/code/AiNews/src/securityIncidentMonitor.js:106)、[db.js:711](/Users/easthash/code/AiNews/src/db.js:711)。

有来源时 dedup key 完全忽略项目和事件类型。一篇安全机构汇总帖包含两个项目时，第二个项目覆盖第一行的项目名和摘要，却继承第一条的推送标记与最高金额，第二个危急事件因此不发。反方向，同一帖仅多了 `?s=20` 或同事件换了报道来源，就会生成新 key，再次推送。

复现：Project A、Project B 使用同一 URL，各为 600 万美元；最终库里仅一条 Project B，发送只有一条 Project A。追加查询参数后 key 又变化。

修复与验收：先定义稳定事件身份，规范化来源链接并把证据来源与事件本体分开；同帖多项目必须独立，同事件跨来源合并并允许升级。迁移不能清空原推送标记导致补发历史消息。

### A03：安全事件解析未落实有效来源、时间窗口和事件类型边界

位置：[securityIncidentMonitor.js:181](/Users/easthash/code/AiNews/src/securityIncidentMonitor.js:181)、[securityIncidentMonitor.js:211](/Users/easthash/code/AiNews/src/securityIncidentMonitor.js:211)。

来源仅检查非空，时间只检查窗口下界，事件类型接受任意字符串。模型输出 `not-a-url`、2099 年的未来时间，或 `price_rally` 普通行情类型，仍可参与证据打分并产生危急告警。prompt 的要求不能替代输出验证。

复现：分别替换以上三个字段，其余保持合格大额事件字段，三条均分类为 critical。

修复与验收：使用结构化 schema 验证 HTTP(S) 来源、允许的类型、时间上下界及有限非负金额；来源账号和原帖一致性也需检查。对缺证据、未知枚举和未来时间记录拒绝原因，不能补默认可信度后推送。

### A12：市场确认标注为 1 小时，实际比较的时间区间不一致

位置：[market/index.js:16](/Users/easthash/code/AiNews/src/market/index.js:16)、[market/index.js:98](/Users/easthash/code/AiNews/src/market/index.js:98)。

Binance 使用前一根 1h K 线收盘价作为 `price1hAgo`，对应当前整点而非滚动一小时前，靠近整点时测到的只是几秒或几分钟变化；还用未结束 K 线的未来收盘时间作为数据更新时间。默认 Finnhub 路径则把当前价相对当日开盘或前收的变化写成 `change1hPct`。不同口径最终应用相同的 1h 阈值，可导致误报或漏报。

复现：注入可辨认的 K 线与 quote 字段，确认 BTC 使用上一根 close=100，而非滚动历史价格；美股使用 day open=100；BTC 更新时间处于未来。

修复与验收：使用与当前采样相隔约 60 分钟且经过时间校验的历史价格；行情来源无法提供对应窗口时明确不可用。用固定时钟覆盖整点前后、日内走势与最近一小时走势相反的样本。

## P2：后续修复

### A01：恢复查询的提前返回留下永久运行锁

位置：[opportunityMonitor.js:519](/Users/easthash/code/AiNews/src/opportunityMonitor.js:519)。

`isRunning=true` 后才检查 `onlyJobNames`；请求任务在当前查询计划中不存在时，直接在 `try/finally` 之外返回。当前计划可能因类型配置或轮换发生变化；使用同一个 monitor 的后续运行全部返回 `already_running`。相关数据库读取和 start-run 写入抛异常也位于 finally 保护之外。恢复 CLI 是短进程，退出会销毁该锁，但共享实例会持续受影响。

复现：先请求 `nonexistent`，再执行普通 run，两次分别得到 `requested_jobs_unavailable` 和 `already_running`。

修复与验收：校验在占锁之前完成，或把占锁后的所有操作置于 finally 保护；测试缺失任务与初始化异常后的再次运行。

### A02：部分成功后遇额度错误，12 小时暂停被清空

位置：[opportunityMonitor.js:602](/Users/easthash/code/AiNews/src/opportunityMonitor.js:602)、[opportunityMonitor.js:638](/Users/easthash/code/AiNews/src/opportunityMonitor.js:638)。

额度错误先设置暂停并退出查询循环，但前面已有候选时仍进入 hydrate/enrichment；完成后无条件清空暂停。既可能在同轮追加模型请求，也会让下一轮忽略 43200 秒退避。

复现：第一项返回一条有效候选，第二项抛 spending-limit；结果为 partial，但 `paused_until=null`。

修复与验收：保留本轮 quota 状态；暂停期间禁止后续模型补查，可继续无模型的整理入库。补“先成功、后额度失败”的测试，而不只测第一项失败。

### A06：结构错误的 JSON 被当成成功的零结果

位置：[securityIncidentMonitor.js:166](/Users/easthash/code/AiNews/src/securityIncidentMonitor.js:166)、[opportunityUtils.js:331](/Users/easthash/code/AiNews/src/opportunityUtils.js:331)、[binanceMajorNewsMonitor.js:232](/Users/easthash/code/AiNews/src/binanceMajorNewsMonitor.js:232)。

三个入口都将缺失或错误类型的列表回退成 `[]`，没有将“有效空列表”与“错误/非约定响应”分开。`{"error":"search failed"}` 和 `{"opportunities":"invalid"}` 可以记为成功采集，进而向日报或看板提供错误的零结果。

复现：安全与机会解析返回 `ok=true`；重大新闻 run 返回 `status=ok`。

修复与验收：根结构和集合字段必须显式有效；只有合同规定的空数组代表成功的零结果，模型错误对象、错误类型与纯标量应失败。

### A08：复用当日 partial run 后，日报写成完整采集

位置：[pipeline.js:344](/Users/easthash/code/AiNews/src/pipeline.js:344)、[db.js:866](/Users/easthash/code/AiNews/src/db.js:866)。

`hasOpportunityRunSince` 把 ok 和 partial 都视为已采集，却只返回布尔值；日报用 `{skipped:true, reason:"already_collected"}` 替代原状态。构建文案时该对象走完成分支。重启、区间采集或手动恢复留下的 partial run 会丢失失败范围；没有展示项时还会声称未发现机会。`already_running`、暂停和 disabled 的 skipped 返回也有相同的完成分支问题。

复现：内存数据库写入当日 partial run 后生成日报，内容同时出现“采集状态：完成”和“今日未发现符合条件”。

修复与验收：复用具体 run ID、状态、任务覆盖与错误；查询尚未完成就等待，暂停或失败保持结果未知，partial 明确未覆盖任务。

### A10：缺失市值、价格和涨跌幅展示为 0

位置：[pipeline.js:397](/Users/easthash/code/AiNews/src/pipeline.js:397)、[binanceMajorNewsMarketMetrics.js:5](/Users/easthash/code/AiNews/src/binanceMajorNewsMarketMetrics.js:5)。

格式化先执行 `Number(value)`，把 `null` 转成 0；补行情模块本来用 null 表示数据库不可用、缺失或过旧，结果消息变成“市值 0、价格 0、涨跌 +0.00%”，掩盖数据缺失。`safeNumber` 也有同样转换。

复现：三个字段均为 null，文案是“流通市值：约 0 美元 | 当前价：$0.00000000 | 24h 涨跌幅：+0.00%”。

修复与验收：显式处理 null、undefined、空串后再转换；缺失显示“暂无可靠数据”，真实零涨跌仍应显示 0%。

### A11：启动时日报采集阻塞安全监控启动

位置：[pipeline.js:794](/Users/easthash/code/AiNews/src/pipeline.js:794)、[pipeline.js:817](/Users/easthash/code/AiNews/src/pipeline.js:817)。

`start()` 依次 await Binance 重大新闻采集和多类日报，最后才启动安全监控与日常定时器。若在当日应采集时间后启动、且没有完成的日报采集记录，大量串行 Hermes 批次会形成安全监控空档。例如 8 批各耗尽配置的 600 秒超时，仅此就可等待约 80 分钟；共享 Hermes 队列并未让安全任务入队，因为安全 monitor 尚未启动。

复现：将 startup 日报采集保持 pending，安全 monitor 的 start 调用始终未发生，释放后才执行。

修复与验收：先建立各监控生命周期并提交任务，由共享队列限制实际调用；用 deferred promise 验证长日报不阻止安全监控初始化。关闭流程也应考虑尚在进行的启动任务。

### A14：HTTP JSON 错误包含查询字符串凭据

位置：[http.js:20](/Users/easthash/code/AiNews/src/http.js:20)、[analyzer/aiAnalyzer.js:522](/Users/easthash/code/AiNews/src/analyzer/aiAnalyzer.js:522)。

JSON 解析失败时将完整 URL 拼入异常。Gemini、Finnhub、Massive 的调用分别可能把 key、token 或 apiKey 放在查询字符串，异常随后写入日志，部分市场异常还会进入持久化数据。若提供方或代理返回 200 HTML/损坏 JSON，将泄漏凭据到应用错误记录。

复现：使用假的 `token=AUDIT_DUMMY_SECRET` 和 200 HTML 响应，异常字符串完整包含该值。未读取、测试或展示真实凭据。

修复与验收：错误记录只保留脱敏的 origin/path、状态与分类，不回显原 URL 查询和原始认证数据；测试三种凭据参数都不会进入异常或日志。

### A15：安全消息全部发送失败，监控健康状态仍为 ok

位置：[securityIncidentMonitor.js:355](/Users/easthash/code/AiNews/src/securityIncidentMonitor.js:355)。

发送返回 failed/unknown 时被收集成普通跳过原因，`last_error` 仍为空，run 与 `system_health` 写 ok。因此安全事件区域的“最近运行正常”不能区分合法去重与整轮投递故障。独立的 `/api/business-delivery` 有失败证据时能指出问题，但不能修正这里的监控状态与文案。

复现：唯一危急事件的 notifier 返回 failed，结果仍为 `ok=true`、`pushed=0`、health=ok。

修复与验收：分别记录采集、过滤和投递结果，投递失败/未知计入 warning/error；queued 仅表示受理，最终送达继续沿已有回执对账，不重复 POST。

### A16：BTC 与黄金主源失败后根本不调用备源

位置：[market/index.js:159](/Users/easthash/code/AiNews/src/market/index.js:159)。

主源 await 在备源的 try 之前；Binance 报错直接退出方法，Coinbase 备源不会被请求。实现只能在主源成功时用备源对比，不能实现 README 声明的主源失败自动切换。Coinbase 当前只提供现价，修复切换时也不能把无历史涨跌的数据当作完整确认。

复现：主源抛异常、备源 mock 可用，捕获的请求列表中没有 Coinbase 请求。

修复与验收：分别获取并判断主备输入，明确完整可用与只有现价的区别；主源失败时仍尝试备源，但缺少 1h 基准时继续 Fail-Closed。

### A17：重大新闻的官方来源限制只存在于 prompt

位置：[binanceMajorNewsMonitor.js:115](/Users/easthash/code/AiNews/src/binanceMajorNewsMonitor.js:115)。

`normalizeItem` 仅验证 X 链接与账号外形，未检查 `source_role` 是否属于官方/核心团队，也未比对链接作者与 `source_account`。明确标成 media 的消息和作者不一致的链接仍被接受，违背 prompt 中禁止媒体、KOL 与转述的硬规则。现有高评分约束不能替代来源身份验证。

复现：9 分融资消息设置 `source_role=media`、链接作者 random_media、账号 @different，normalize 仍返回有效记录。

修复与验收：先拒绝不允许的角色与作者不一致，官方身份需要项目与账号的可信关联证据；不能因字段缺失而默认 project_official。增加角色拒绝、账号一致性和无法核实身份的测试。

## 建议修复顺序

1. 先处理外部输入与推送边界：A09、A03、A06、A14、A17。
2. 再处理告警正确性：A04、A05、A07、A12、A13、A16。
3. 最后修复调度与状态：A01、A02、A08、A10、A11、A15。

每组修复应将对应复现改写成“期望正确行为”的回归测试，再运行相关测试与全量检查。代码修复、部署和真实业务送达验收分别记录；本报告本身不改变运行授权，也不新增日报或巡检调度。
