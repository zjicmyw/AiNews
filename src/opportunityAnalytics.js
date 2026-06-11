import { parseMaxApyPercent } from "./opportunityUtils.js";

export const CEX_EXCHANGES = ["Binance", "OKX", "Bybit", "Gate", "Bitget"];

export const CEX_CATEGORIES = [
  { id: "stablecoin_earn", label: "稳定币理财" },
  { id: "launch", label: "打新" },
  { id: "pre_ipo", label: "Pre-IPO" },
  { id: "short_term", label: "短期活动" }
];

export const CEX_GAP_QUERIES = {
  stablecoin_earn: "USDT OR USDC OR USD1 Earn APR APY boosted limited-time >=8",
  launch: "Launchpad Launchpool IEO IDO Farm airdrop task official",
  pre_ipo: "Pre-IPO Pre-token Pre-listing SpaceX xStocks pre-market IPO Access",
  short_term: "trading competition leaderboard points boost double rewards wallet campaign"
};

export function buildCexCoverage(items = []) {
  const rows = CEX_EXCHANGES.map((exchange) => {
    const cells = CEX_CATEGORIES.map((category) => {
      const matches = items.filter(
        (item) => item.section === "cex" && item.exchange === exchange && item.type === category.id
      );
      const actionable = matches.filter((item) =>
        item.review ? item.review.label === "可参与" : item.status === "active"
      ).length;
      const watch = matches.filter((item) => item.review?.label === "观察项").length;
      const unverified = matches.filter((item) => item.status === "unverified").length;
      const urgent = matches.filter((item) => item.urgency?.level === "urgent" || item.urgency?.level === "soon").length;
      const highestApy = matches.reduce((max, item) => {
        const parsed = parseMaxApyPercent(item);
        const apy = Number.isFinite(parsed) ? parsed : Number(item.apy || 0);
        return Math.max(max, apy);
      }, 0);
      const status = matches.length === 0 ? "missing" : actionable > 0 ? "covered" : "watch";
      return {
        type: category.id,
        label: category.label,
        count: matches.length,
        actionable,
        watch,
        unverified,
        urgent,
        highest_apy: highestApy || null,
        status,
        examples: matches.slice(0, 2).map((item) => item.activity_name)
      };
    });
    const total = cells.reduce((sum, cell) => sum + cell.count, 0);
    const covered = cells.filter((cell) => cell.count > 0).length;
    return { exchange, total, covered, cells };
  });

  const totalCells = rows.length * CEX_CATEGORIES.length;
  const coveredCells = rows.reduce((sum, row) => sum + row.covered, 0);
  const missingCells = totalCells - coveredCells;
  const gaps = rows
    .flatMap((row) =>
      row.cells
        .filter((cell) => cell.status === "missing")
        .map((cell) => {
          const categoryPriority = ["stablecoin_earn", "pre_ipo"].includes(cell.type) ? 2 : 1;
          const emptyExchangePriority = row.total === 0 ? 2 : 0;
          const priorityScore = categoryPriority + emptyExchangePriority;
          return {
            exchange: row.exchange,
            type: cell.type,
            label: cell.label,
            priority: priorityScore >= 4 ? "high" : priorityScore >= 3 ? "medium" : "normal",
            priority_score: priorityScore,
            reason:
              row.total === 0
                ? `${row.exchange} 当前没有任何符合筛选门槛的 CEX 机会`
                : `${row.exchange} 当前缺少${cell.label}机会`,
            suggested_query: `${row.exchange} ${CEX_GAP_QUERIES[cell.type] || cell.label}`
          };
        })
    )
    .sort(
      (a, b) =>
        b.priority_score - a.priority_score ||
        CEX_EXCHANGES.indexOf(a.exchange) - CEX_EXCHANGES.indexOf(b.exchange) ||
        CEX_CATEGORIES.findIndex((category) => category.id === a.type) -
          CEX_CATEGORIES.findIndex((category) => category.id === b.type)
    );
  const emptyExchanges = rows.filter((row) => row.total === 0).map((row) => row.exchange);
  const missingByCategory = CEX_CATEGORIES.reduce((acc, category) => {
    acc[category.id] = rows.filter((row) =>
      row.cells.some((cell) => cell.type === category.id && cell.status === "missing")
    ).length;
    return acc;
  }, {});

  return {
    categories: CEX_CATEGORIES,
    exchanges: CEX_EXCHANGES,
    rows,
    gaps,
    summary: {
      total_cells: totalCells,
      covered_cells: coveredCells,
      missing_cells: missingCells,
      coverage_ratio: totalCells ? Number((coveredCells / totalCells).toFixed(2)) : 0,
      empty_exchanges: emptyExchanges,
      missing_by_category: missingByCategory
    }
  };
}
