import React, { useState } from "react";

const WIDTH = 1000;
const HEIGHT = 240;
const PAD = { top: 18, right: 64, bottom: 30, left: 52 };

function niceMax(value) {
  if (!(value > 0)) return 1;
  const raw = value / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((item) => item * power).find((item) => item >= raw) || power * 10;
  return step * 4;
}

function costLabel(value) {
  if (value >= 1e4) return `¥${(value / 1e4).toFixed(1).replace(/\.0$/, "")}万`;
  return `¥${value >= 100 ? Math.round(value) : Number(value.toFixed(value < 10 ? 1 : 0))}`;
}

/** 生成条数（左轴）与预计成本（右轴）双折线图，带面积填充、数据点和悬停提示。纯 SVG。 */
export default function CostTrendChart({ series }) {
  const [hover, setHover] = useState(-1);
  const count = series.length;
  const maxGenerated = niceMax(Math.max(0, ...series.map((item) => item.generated)));
  const maxCost = niceMax(Math.max(0, ...series.map((item) => item.cost)));
  const innerWidth = WIDTH - PAD.left - PAD.right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (index) => PAD.left + (count <= 1 ? innerWidth / 2 : index / (count - 1) * innerWidth);
  const yGenerated = (value) => PAD.top + (1 - value / maxGenerated) * innerHeight;
  const yCost = (value) => PAD.top + (1 - value / maxCost) * innerHeight;
  const baseline = PAD.top + innerHeight;
  const line = (y, field) => series.map((item, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(item[field]).toFixed(1)}`).join(" ");
  const area = (y, field) => count ? `${line(y, field)} L${x(count - 1).toFixed(1)},${baseline} L${x(0).toFixed(1)},${baseline} Z` : "";
  const ticks = [0, 1, 2, 3, 4];
  const slot = count > 1 ? innerWidth / (count - 1) : innerWidth;
  const labelEvery = count > 16 ? Math.ceil(count / 12) : 1;
  const hasData = series.some((item) => item.generated || item.cost);
  const active = series[hover];
  const tipLeft = active ? (x(hover) > WIDTH / 2 ? x(hover) - 170 : x(hover) + 14) : 0;

  return (
    <svg className="trend-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="生成条数与预计成本折线图" onMouseLeave={() => setHover(-1)}>
      <defs>
        <linearGradient id="trend-fill-generated" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" className="trend-stop-generated" stopOpacity="0.28" /><stop offset="100%" className="trend-stop-generated" stopOpacity="0" /></linearGradient>
        <linearGradient id="trend-fill-cost" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" className="trend-stop-cost" stopOpacity="0.26" /><stop offset="100%" className="trend-stop-cost" stopOpacity="0" /></linearGradient>
      </defs>
      {ticks.map((tick) => {
        const y = PAD.top + (1 - tick / 4) * innerHeight;
        return <g key={tick} className={tick ? "trend-grid" : "trend-axis"}>
          <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} />
          <text className="trend-axis-generated" x={PAD.left - 8} y={y + 4} textAnchor="end">{Math.round(maxGenerated * tick / 4)}</text>
          <text className="trend-axis-cost" x={WIDTH - PAD.right + 8} y={y + 4} textAnchor="start">{costLabel(maxCost * tick / 4)}</text>
        </g>;
      })}
      {series.map((item, index) => (index % labelEvery === 0 || index === count - 1) && (
        <text key={item.key} className={`trend-label${index === hover ? " active" : ""}`} x={x(index)} y={HEIGHT - 8} textAnchor="middle">{item.label}</text>
      ))}
      {hasData && <>
        <path className="trend-area-generated" d={area(yGenerated, "generated")} fill="url(#trend-fill-generated)" />
        <path className="trend-area-cost" d={area(yCost, "cost")} fill="url(#trend-fill-cost)" />
        <path className="trend-line-generated" d={line(yGenerated, "generated")} />
        <path className="trend-line-cost" d={line(yCost, "cost")} />
        {active && <line className="trend-hover-line" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={baseline} />}
        {series.map((item, index) => <g key={item.key}>
          <circle className="trend-dot-generated" cx={x(index)} cy={yGenerated(item.generated)} r={index === hover ? 5 : 3.2} />
          <circle className="trend-dot-cost" cx={x(index)} cy={yCost(item.cost)} r={index === hover ? 5 : 3.2} />
        </g>)}
      </>}
      {series.map((item, index) => (
        <rect key={item.key} className="trend-hit" x={x(index) - slot / 2} y={PAD.top} width={slot} height={innerHeight} onMouseEnter={() => setHover(index)}>
          <title>{`${item.label}：生成 ${item.generated} 条，预计成本 ¥${Number(item.cost || 0).toFixed(2)}`}</title>
        </rect>
      ))}
      {active && <g className="trend-tip" transform={`translate(${tipLeft},${PAD.top + 4})`} pointerEvents="none">
        <rect width="156" height="62" rx="8" />
        <text x="12" y="20" className="trend-tip-title">{active.label}</text>
        <text x="12" y="38"><tspan className="trend-tip-generated">●</tspan> 生成 {active.generated} 条</text>
        <text x="12" y="54"><tspan className="trend-tip-cost">●</tspan> 成本 ¥{Number(active.cost || 0).toFixed(2)}</text>
      </g>}
      {!hasData && <text className="trend-empty" x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle">这段时间还没有已完成的任务</text>}
    </svg>
  );
}
