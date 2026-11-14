import React from "react";

const WIDTH = 1000;
const HEIGHT = 230;
const PAD = { top: 16, right: 16, bottom: 30, left: 64 };

function compactMoney(cents) {
  const value = Number(cents || 0) / 100;
  const abs = Math.abs(value);
  if (abs >= 1e8) return `¥${(value / 1e8).toFixed(1).replace(/\.0$/, "")}亿`;
  if (abs >= 1e4) return `¥${(value / 1e4).toFixed(1).replace(/\.0$/, "")}万`;
  return `¥${Math.round(value)}`;
}

function money(cents) {
  return `¥${(Number(cents || 0) / 100).toFixed(2)}`;
}

function niceStep(range) {
  const raw = range / 4;
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((value) => value * power).find((value) => value >= raw) || power * 10;
}

/** 收入/成本柱状图 + 净收益折线（纯 SVG，无外部依赖）。 */
export default function RevenueChart({ points, selectedKey, onSelect }) {
  const values = points.flatMap((point) => [point.incomeCents, point.costCents, point.netCents]);
  let max = Math.max(0, ...values);
  let min = Math.min(0, ...values);
  if (max === min) max = min + 10000;
  const step = niceStep(max - min);
  max = Math.ceil(max / step) * step;
  min = Math.floor(min / step) * step;
  const innerWidth = WIDTH - PAD.left - PAD.right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const y = (value) => PAD.top + (max - value) / (max - min) * innerHeight;
  const slot = innerWidth / Math.max(1, points.length);
  const barWidth = Math.min(22, slot * 0.28);
  const center = (index) => PAD.left + slot * index + slot / 2;
  const ticks = [];
  for (let value = min; value <= max + 1e-6; value += step) ticks.push(value);
  const linePath = points.map((point, index) => `${index ? "L" : "M"}${center(index).toFixed(1)},${y(point.netCents).toFixed(1)}`).join(" ");
  const hasData = values.some((value) => value !== 0);

  return (
    <svg className="revenue-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="收入、成本柱状图与净收益折线图">
      {ticks.map((value) => (
        <g key={value} className={value === 0 ? "revenue-axis-zero" : "revenue-grid"}>
          <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(value)} y2={y(value)} />
          <text x={PAD.left - 10} y={y(value) + 4} textAnchor="end">{compactMoney(value)}</text>
        </g>
      ))}
      {points.map((point, index) => {
        const x = center(index);
        const selected = point.key === selectedKey;
        return (
          <g key={point.key} className={`revenue-slot${selected ? " selected" : ""}`} onClick={() => onSelect?.(point.key)}>
            <title>{`${point.year}年${point.label}\n收入 ${money(point.incomeCents)}\n成本 ${money(point.costCents)}\n净收益 ${money(point.netCents)}`}</title>
            <rect className="revenue-hit" x={x - slot / 2 + 2} y={PAD.top - 6} width={slot - 4} height={innerHeight + 12} rx="8" />
            <rect className="revenue-bar-income" x={x - barWidth - 1} y={y(Math.max(0, point.incomeCents))} width={barWidth} height={Math.abs(y(point.incomeCents) - y(0))} rx="3" />
            <rect className="revenue-bar-cost" x={x + 1} y={y(Math.max(0, point.costCents))} width={barWidth} height={Math.abs(y(point.costCents) - y(0))} rx="3" />
            <text className="revenue-label" x={x} y={HEIGHT - 8} textAnchor="middle">{point.label}</text>
          </g>
        );
      })}
      {hasData && <path className="revenue-line" d={linePath} />}
      {hasData && points.map((point, index) => (
        <circle key={point.key} className={point.netCents < 0 ? "revenue-dot negative" : "revenue-dot"} cx={center(index)} cy={y(point.netCents)} r="4" />
      ))}
      {!hasData && <text className="revenue-empty" x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle">这段时间还没有收入或成本记录</text>}
    </svg>
  );
}
