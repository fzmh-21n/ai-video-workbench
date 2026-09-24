import React from "react";

export default function FixedContentControls({
  fixedContent,
  onChange,
  onManage,
  onSelect,
  selectedTemplateId,
  templates,
  versionLabel,
}) {
  return (
    <section className="fixed-content-controls">
      <label className="field-label fixed-label">
        固定内容（{versionLabel}）
        <span>跟随当前任务项目保存；提交时自动放在提示词最前方</span>
      </label>
      <div className="fixed-content-toolbar">
        <select aria-label="当前项目固定内容" value={selectedTemplateId} onChange={(event) => onSelect(event.target.value)}>
          {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
        <button className="secondary-button" type="button" onClick={onManage}>管理固定内容</button>
      </div>
      <textarea
        className="fixed-content"
        value={fixedContent}
        onChange={(event) => onChange(event.target.value)}
        placeholder="例如：统一画风、人物一致性、镜头规范等每次都要携带的内容"
      />
      <div className="fixed-content-count">固定内容 {fixedContent.length} 字</div>
    </section>
  );
}
