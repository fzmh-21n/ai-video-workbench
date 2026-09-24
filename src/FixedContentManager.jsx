import React, { useEffect, useMemo, useState } from "react";

export default function FixedContentManager({ activeTemplateId, onClose, onCreate, onDelete, onSave, onSelect, templates }) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState(activeTemplateId || templates[0]?.id || "");
  const [draft, setDraft] = useState({ name: "", sd20: "", sd25: "" });
  const [error, setError] = useState("");

  const editing = templates.find((item) => item.id === editingId) || templates[0];
  useEffect(() => {
    if (editing) setDraft({ name: editing.name, sd20: editing.sd20, sd25: editing.sd25 });
  }, [editing?.id]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return templates;
    return templates.filter((item) => [item.name, item.sd20, item.sd25]
      .some((value) => String(value || "").toLowerCase().includes(keyword)));
  }, [query, templates]);

  function choose(id) {
    setEditingId(id);
    setError("");
  }

  function create() {
    try {
      const created = onCreate();
      setEditingId(created.id);
      setError("");
    } catch (createError) {
      setError(createError.message || "新建失败");
    }
  }

  function save() {
    try {
      onSave(editingId, draft);
      setError("");
    } catch (saveError) {
      setError(saveError.message || "保存失败");
    }
  }

  function remove() {
    if (!editing) return;
    if (!window.confirm(`确定删除固定内容“${editing.name}”吗？使用它的项目会自动改用剩余的第一条固定内容。`)) return;
    try {
      const nextId = onDelete(editing.id);
      setEditingId(nextId);
      setError("");
    } catch (deleteError) {
      setError(deleteError.message || "删除失败");
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="fixed-content-dialog" role="dialog" aria-modal="true" aria-label="固定内容管理" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading"><div><span>FIXED CONTENT</span><h2>固定内容管理</h2></div><button onClick={onClose}>×</button></div>
        <div className="fixed-content-manager-layout">
          <aside>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或内容" />
            <button className="primary-button" onClick={create}>＋ 新建固定内容</button>
            <div className="fixed-content-template-list">
              {filtered.map((item) => (
                <button className={item.id === editingId ? "active" : ""} key={item.id} onClick={() => choose(item.id)}>
                  <strong>{item.name}</strong>
                  {item.id === activeTemplateId && <span>当前项目使用</span>}
                </button>
              ))}
              {!filtered.length && <p>没有匹配的固定内容。</p>}
            </div>
          </aside>
          <div className="fixed-content-editor">
            {editing ? <>
              <label><span>固定内容名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <label><span>SD2.0 固定内容</span><textarea value={draft.sd20} onChange={(event) => setDraft({ ...draft, sd20: event.target.value })} /></label>
              <label><span>SD2.5 固定内容</span><textarea value={draft.sd25} onChange={(event) => setDraft({ ...draft, sd25: event.target.value })} /></label>
              {error && <p className="task-project-error">{error}</p>}
              <div className="dialog-actions">
                <button className="primary-button" onClick={save}>保存修改</button>
                <button onClick={() => onSelect(editing.id)}>设为当前项目固定内容</button>
                <button className="danger-button" onClick={remove}>删除</button>
              </div>
            </> : <p>请新建一条固定内容。</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
