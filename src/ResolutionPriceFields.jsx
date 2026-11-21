import React from "react";
import { isResolutionPricedModel, LG_COST_RESOLUTIONS, modelResolutionPrices } from "./costAnalytics.js";

export default function ResolutionPriceFields({ model, entry = {}, onChange, labelPrefix = model }) {
  if (!isResolutionPricedModel(model)) return null;
  const prices = modelResolutionPrices(model, entry);
  return <div className="resolution-prices">
    <div className="resolution-price-grid">{LG_COST_RESOLUTIONS.map((resolution) => <label key={resolution}>
      <span>{resolution} · 每条</span><div><input aria-label={`${labelPrefix} ${resolution} 每条金额`} type="number" min="0" step="0.01" value={prices[resolution] ?? ""} onChange={(event) => onChange(resolution, event.target.value)} placeholder="沿用通用价" /><b>元</b></div>
    </label>)}</div>
    <small>按任务提交时记录的分辨率计价。480p 默认 ¥3.5、720p 默认 ¥4.5，可修改；留空沿用通用价。1080p／4k 未预设价格；分辨率未记录的历史任务也沿用通用价，不推测为 720p。</small>
  </div>;
}
