import { financeMonths, lumpSumTotals, projectFinanceSummary } from "./projectFinance.js";

function shiftMonth(month, delta) {
  const [year, value] = String(month).split("-").map(Number);
  const date = new Date(year, value - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function chartMonths(endMonth, count = 12) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(endMonth || ""))) throw new Error("图表月份必须是 YYYY-MM");
  return Array.from({ length: count }, (_, index) => shiftMonth(endMonth, index - count + 1));
}

/**
 * 收益曲线数据：最近 count 个月（截至 endMonth）的收入、成本（手动+API 估算）和净收益；
 * 未归类历史汇总不属于任何月份，单独作为“历史汇总”一组，并计入累计合计。
 */
export function buildRevenueChart({ tasks = [], settings = {}, entries = [], lumps = {}, projectName = "all", endMonth, count = 12 }) {
  const months = chartMonths(endMonth, count).map((month) => {
    const summary = projectFinanceSummary(tasks, settings, entries, { projectName, month });
    return {
      key: month,
      label: `${Number(month.slice(5))}月`,
      year: month.slice(0, 4),
      incomeCents: summary.incomeCents,
      costCents: summary.totalCostCents,
      netCents: summary.netCents,
    };
  });
  const lump = lumpSumTotals(lumps, projectName);
  const allTime = projectFinanceSummary(tasks, settings, entries, { projectName, month: "" });
  const totals = {
    incomeCents: allTime.incomeCents + lump.incomeCents,
    costCents: allTime.totalCostCents + lump.costCents,
  };
  totals.netCents = totals.incomeCents - totals.costCents;
  // 累计视图：起点 = 未归类历史汇总 + 图表窗口之前所有月份，再逐月累加。
  const windowStart = months[0].key;
  let incomeCents = lump.incomeCents;
  let costCents = lump.costCents;
  for (const month of financeMonths(tasks, entries, projectName)) {
    if (month >= windowStart) continue;
    const summary = projectFinanceSummary(tasks, settings, entries, { projectName, month });
    incomeCents += summary.incomeCents;
    costCents += summary.totalCostCents;
  }
  const baseline = { incomeCents, costCents, netCents: incomeCents - costCents };
  const cumulative = months.map((month) => {
    incomeCents += month.incomeCents;
    costCents += month.costCents;
    return { ...month, incomeCents, costCents, netCents: incomeCents - costCents };
  });
  return { months, cumulative, baseline, lump: lump.hasValue ? lump : null, totals };
}
