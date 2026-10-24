import React, { useEffect, useRef, useState } from "react";
import { normalizeApiKey } from "./apiKey.js";
import { readCredentials, saveCredentials } from "./credentialStore.js";
import { TEXT_ATTACHMENT_ACCEPT, TEXT_ATTACHMENT_MAX_BYTES, TEXT_REQUEST_MAX_BYTES, attachmentKind, readTextAttachment } from "./textAttachments.js";
import {
  TEXT_PROTOCOLS,
  buildTextRequest,
  normalizeTextModels,
  readTextResponse,
  textServiceError,
} from "./textService.js";

const PROFILE_ID = "text-canseedream";
const SETTINGS_KEY = "text-workbench-settings-v1";
const EMPTY_RESULT = { text: "", reasoning: "", usage: null, complete: false, error: "", stopReason: "" };

function savedSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}

export default function TextWorkbench({ onVideoMode, onImageMode, onLogout }) {
  const [apiKey, setApiKey] = useState(() => readCredentials(PROFILE_ID).apiKey);
  const [rememberKey, setRememberKey] = useState(() => readCredentials(PROFILE_ID).remember);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState(() => savedSettings().model || "");
  const [protocol, setProtocol] = useState(() => savedSettings().protocol || "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(() => savedSettings().maxOutputTokens || 4096);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("idle");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState(EMPTY_RESULT);
  const [requestInfo, setRequestInfo] = useState(null);
  const [canRecover, setCanRecover] = useState(false);
  const controllerRef = useRef(null);
  const inFlightRef = useRef(false);
  const originalRequestRef = useRef(null);
  const readingFilesRef = useRef(false);
  const attachmentsRef = useRef([]);
  const modelRow = models.find((item) => item.id === model);
  const protocols = modelRow?.protocols.length
    ? TEXT_PROTOCOLS.filter((item) => modelRow.protocols.includes(item.id))
    : TEXT_PROTOCOLS;
  const submitDisabledReason = busy ? "上一条推理正在进行中，请等待或停止接收。"
    : readingFiles ? "正在读取附件，请等待完成。"
      : loadingModels ? "正在读取模型，请等待完成。"
        : !modelRow ? "请先读取文本模型并选择模型。"
          : !protocols.some((item) => item.id === protocol) ? "请选择上方的“接口协议”；按接入文档，Claude 类模型使用 Messages。"
            : !prompt.trim() ? "请在“输入文本 / 需求”中填写需要模型做什么，附件不能替代需求。" : "";

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ model, protocol, maxOutputTokens }));
  }, [model, protocol, maxOutputTokens]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  function changeCredentials(value, remember) {
    saveCredentials(PROFILE_ID, { apiKey: value, remember });
    if (normalizeApiKey(value) !== normalizeApiKey(apiKey)) {
      setModels([]);
      setProtocol("");
    }
    setApiKey(value);
    setRememberKey(remember);
  }

  function chooseModel(id, rows = models, preferredProtocol = protocol) {
    const row = rows.find((item) => item.id === id);
    setModel(id);
    const availableProtocols = row?.protocols.length ? row.protocols : TEXT_PROTOCOLS.map((item) => item.id);
    setProtocol(row ? availableProtocols.includes(preferredProtocol) ? preferredProtocol : row.protocols[0] || "" : "");
    if (row?.defaultMaxOutputTokens) setMaxOutputTokens(row.defaultMaxOutputTokens);
    else if (row?.maxOutputTokens) setMaxOutputTokens((current) => Math.min(Number(current) || 4096, row.maxOutputTokens));
  }

  async function loadModels() {
    const key = normalizeApiKey(apiKey);
    if (!key.startsWith("sk_txt_")) return setNotice("请填入文本专用 sk_txt_ Key；视频、图片 Key 不能使用。");
    setLoadingModels(true);
    setNotice("");
    try {
      const response = await fetch("/api/text/models", { headers: { "x-text-api-key": key }, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(textServiceError(body));
      const rows = normalizeTextModels(body);
      setModels(rows);
      chooseModel(rows.some((item) => item.id === model) ? model : rows[0]?.id || "", rows, savedSettings().protocol);
      setNotice(rows.length ? `已读取 ${rows.length} 个文本模型。` : "这个文本 Key 没有可用模型，请检查中转后台的 Key 权限。");
    } catch (error) {
      setNotice(error.message || "读取模型失败");
    } finally { setLoadingModels(false); }
  }

  async function addFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length || inFlightRef.current || readingFilesRef.current) return;
    readingFilesRef.current = true;
    setReadingFiles(true);
    const issues = [];
    let added = 0;
    try {
      for (const file of files) {
        const sourceKey = JSON.stringify([file.name, file.size, file.lastModified]);
        if (attachmentsRef.current.some((item) => item.sourceKey === sourceKey)) continue;
        setNotice(`正在读取附件：${file.name}（不会发起收费推理）`);
        try {
          const kind = attachmentKind(file.name);
          if (!kind) throw new Error("不支持该文件类型；旧版 DOC 请另存为 DOCX。");
          let attachment;
          if (kind === "document") {
            if (file.size > TEXT_ATTACHMENT_MAX_BYTES) throw new Error("文档超过工作台单文件 10 MiB 上限，请拆分后再上传。");
            const form = new FormData();
            form.append("file", file);
            const response = await fetch("/api/text/extract", { method: "POST", body: form });
            const body = await response.json();
            if (!response.ok) throw new Error(textServiceError(body) || "文档正文读取失败");
            if (typeof body.text !== "string" || !body.text.trim()) throw new Error("文档未读取到正文；扫描件请改用图片上传。");
            attachment = { name: file.name, kind: "text", text: body.text, size: file.size };
          } else attachment = await readTextAttachment(file);
          const next = [...attachmentsRef.current, { ...attachment, id: crypto.randomUUID(), sourceKey }];
          const contentBytes = next.reduce((total, item) => total + new TextEncoder().encode(item.kind === "image" ? item.dataUrl : item.text).byteLength, 0);
          if (contentBytes > TEXT_REQUEST_MAX_BYTES) throw new Error("附件内容合计超过 20 MiB，请减少附件；之前成功添加的附件仍保留。");
          attachmentsRef.current = next;
          setAttachments(attachmentsRef.current);
          added++;
        } catch (error) { issues.push(`${file.name}：${error.message || "读取失败"}`); }
      }
      setNotice(`已添加 ${added} 个附件。${issues.length ? `部分文件未添加：${issues.join("；")}` : "正文和图片将在点击开始推理时一起发送；附件较多会增加输入用量。"}`);
    } finally {
      readingFilesRef.current = false;
      setReadingFiles(false);
    }
  }

  function removeAttachment(id) {
    attachmentsRef.current = id ? attachmentsRef.current.filter((item) => item.id !== id) : [];
    setAttachments(attachmentsRef.current);
  }

  async function runRequest(request, replay = false) {
    if (inFlightRef.current || readingFilesRef.current) return;
    inFlightRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    originalRequestRef.current = request;
    setBusy(true);
    setStatus("running");
    setCanRecover(false);
    setNotice(replay ? "正在使用原 Key、原参数和原请求标识恢复；不会主动新建请求。" : "正在接收回答。切换到视频或图片页面不会中断；刷新或关闭网页会断开连接。");
    setResult(EMPTY_RESULT);
    setRequestInfo({ id: request.idempotencyKey, requestId: "", replayed: false });
    try {
      const response = await fetch(`/api/text/${request.protocol}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-text-api-key": request.apiKey, "Idempotency-Key": request.idempotencyKey },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      setRequestInfo({ id: request.idempotencyKey, requestId: response.headers.get("x-request-id") || "", replayed: response.headers.get("x-idempotent-replay") === "true" });
      const answer = await readTextResponse(response, request.protocol, setResult);
      setResult(answer);
      if (answer.error) {
        setStatus("failed");
        setNotice(answer.error);
      } else if (!answer.complete) {
        setStatus("uncertain");
        setCanRecover(true);
        setNotice("连接结束，但没有收到完整终态。不能据此判断未计费；请先查原账单，或尝试恢复原请求。");
      } else {
        setStatus("completed");
        setNotice("回答已完成。用量按接口实际返回显示，最终费用以中转账单为准。");
      }
    } catch (error) {
      const uncertain = controller.signal.aborted || !error.status || error.status === 408 || error.status >= 500;
      setStatus(uncertain ? "uncertain" : "failed");
      setCanRecover(uncertain);
      setNotice(controller.signal.aborted
        ? "已停止接收，不等于取消上游推理，也不代表免费。请核对原账单；需要继续时可恢复原请求。"
        : error.status === 410
          ? "原回答缓存已失效，无法恢复。请先核对原账单；如需重新生成，要主动提交新请求，可能再次计费。"
          : `${error.message || "请求失败"}${uncertain ? "；没有自动重发，请核对原账单或恢复原请求。" : ""}`);
    } finally {
      controllerRef.current = null;
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (inFlightRef.current || readingFilesRef.current || loadingModels) return;
    try {
      const key = normalizeApiKey(apiKey);
      if (!key.startsWith("sk_txt_")) throw new Error("请使用文本专用 sk_txt_ Key。");
      if (!modelRow) throw new Error("请先读取模型并选择可用模型。");
      if (!protocols.some((item) => item.id === protocol)) throw new Error("请选择该模型支持的接口协议。");
      if (modelRow.maxOutputTokens && Number(maxOutputTokens) > modelRow.maxOutputTokens) throw new Error(`这个模型输出上限为 ${modelRow.maxOutputTokens} tokens。`);
      if (attachments.some((item) => item.kind === "image") && modelRow.supportsImages === false) throw new Error("模型目录明确标注这个模型不支持图片，请移除图片或换用支持识图的模型。");
      const body = buildTextRequest({ model, protocol, prompt, maxOutputTokens: Number(maxOutputTokens), attachments });
      if (status === "uncertain" && !window.confirm("上一条请求状态未确认，可能已计费。确定提交新的、可能单独计费的请求吗？")) return;
      runRequest({ apiKey: key, protocol, body, idempotencyKey: crypto.randomUUID() });
    } catch (error) { setNotice(error.message); }
  }

  async function copyAnswer() {
    try { await navigator.clipboard.writeText(result.text); setNotice("回答已复制。"); }
    catch { setNotice("复制失败，请选中回答文字后手动复制。"); }
  }

  return <main className="workspace-shell text-workbench">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">文</span><div><h1>AI 文本推理工作台</h1><p>CanSeeDream 文本专用接口 · 按 token 计费 · 与视频、图片任务独立</p></div></div>
      <div className="provider-switcher">
        <button className="secondary-button" onClick={onVideoMode}>视频生成</button>
        <button className="secondary-button" onClick={onImageMode}>图片生成</button>
        <a href="https://see.ximeiedu.org/text-service" target="_blank" rel="noreferrer">文本 Key / 售价 / 账单</a>
        <button className="logout-button" onClick={onLogout}>退出登录</button>
      </div>
    </header>
    <div className="workspace-grid text-layout">
      <section className="panel">
        <div className="panel-heading"><h2>文本推理</h2><span>单次文本请求</span></div>
        <form className="panel-body" onSubmit={submit}>
          <div className="text-settings">
            <label><span>文本专用 API Key</span><input type="password" autoComplete="off" value={apiKey} placeholder="sk_txt_...（不是视频、图片 Key）" disabled={busy || loadingModels} onChange={(event) => changeCredentials(event.target.value, rememberKey)} /></label>
            <button className="secondary-button" type="button" disabled={busy || loadingModels} onClick={loadModels}>{loadingModels ? "读取中…" : "读取文本模型"}</button>
          </div>
          <label className="check-row"><input type="checkbox" checked={rememberKey} disabled={busy || loadingModels} onChange={(event) => changeCredentials(apiKey, event.target.checked)} />在这台浏览器记住文本 Key（公共电脑请勿开启）</label>
          <div className="text-settings text-model-settings">
            <label><span>模型</span><select value={models.length ? model : ""} disabled={busy || loadingModels || !models.length} onChange={(event) => chooseModel(event.target.value)}><option value="">请先读取文本模型</option>{models.map((item) => <option key={item.id} value={item.id}>{item.name === item.id ? item.id : `${item.name} · ${item.id}`}</option>)}</select></label>
            <label><span>接口协议</span><select value={protocol} disabled={busy || !modelRow} onChange={(event) => setProtocol(event.target.value)}><option value="">请选择支持的协议</option>{protocols.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label><span>最大输出 tokens</span><input type="number" min="1" step="1" max={modelRow?.maxOutputTokens || undefined} value={maxOutputTokens} disabled={busy} onChange={(event) => setMaxOutputTokens(event.target.value)} /></label>
          </div>
          {modelRow && !modelRow.protocols.length && <p className="text-help">模型目录未注明协议，请按该模型说明选择，不能保证三个协议都支持。</p>}
          <label className="field-label" htmlFor="text-prompt">输入文本 / 需求</label>
          <textarea id="text-prompt" value={prompt} disabled={busy} placeholder="输入需要分析、推理或改写的文本…" onChange={(event) => setPrompt(event.target.value)} />
          <div className="text-attachments">
            <div className="text-attachment-heading"><label htmlFor="text-attachments">上传文件 / 图片</label>{attachments.length > 0 && <button className="secondary-button" type="button" disabled={busy || readingFiles} onClick={() => removeAttachment(null)}>清空附件</button>}</div>
            <input id="text-attachments" type="file" multiple accept={TEXT_ATTACHMENT_ACCEPT} disabled={busy || readingFiles} onChange={addFiles} />
            <p className="text-help">支持 TXT、MD、JSON、CSV、TSV、LOG、Word（DOCX）、PDF 和 PNG/JPG/WEBP 图片，可一次选择多个文件。文档只读取正文，不包含排版和内嵌图片；扫描版 PDF 不会自动做 OCR。工作台上限：文档/文本单文件 10 MiB，图片单张 5 MiB，整次请求 20 MiB，不会静默截断。</p>
            {readingFiles && <p role="status">正在读取附件，请等待完成后提交…</p>}
            {attachments.map((item) => <article className="text-attachment" key={item.id}>
              <div><strong>{item.name}</strong><span>{item.kind === "image" ? "图片" : `已读取 ${item.text.length.toLocaleString()} 字符`}</span><button className="secondary-button" type="button" disabled={busy || readingFiles} onClick={() => removeAttachment(item.id)}>移除</button></div>
              {item.kind === "image" ? <img src={item.dataUrl} alt={item.name} /> : <details><summary>查看读取的正文</summary><pre>{item.text.slice(0, 2000)}</pre>{item.text.length > 2000 && <p className="text-help">仅预览前 2000 个字符，提交时会发送完整正文。</p>}</details>}
            </article>)}
            {attachments.some((item) => item.kind === "image") && <p className="text-help">{modelRow?.supportsImages === false ? "当前模型不支持图片，提交前请切换模型。" : modelRow?.supportsImages === true ? "模型目录标注支持识图；具体图片限制仍以中转校验为准。" : "模型目录尚未明确识图能力，请选择支持图片输入的模型；原生图片格式不代表所有模型都支持。"} 图片可能增加预算预占和输入费用。</p>}
          </div>
          <p className="text-help">只发送你填写的需求和手动选择的附件，不会自动读取其他项目素材。附件、输入和回答不保存到任务记录；刷新前请复制需要保留的内容。</p>
          <div className="submit-row">
            <button className="primary-button" type="submit" disabled={Boolean(submitDisabledReason)} aria-describedby={submitDisabledReason ? "text-submit-help" : undefined}>{busy ? "推理中…" : requestInfo ? "提交新请求（单独计费）" : "开始推理"}</button>
            {busy && <button className="secondary-button" type="button" onClick={() => controllerRef.current?.abort()}>停止接收</button>}
            {!busy && canRecover && <button className="secondary-button" type="button" disabled={readingFiles} onClick={() => runRequest(originalRequestRef.current, true)}>恢复原请求</button>}
          </div>
          {submitDisabledReason && <p className="text-help" id="text-submit-help" role="status">暂不能开始：{submitDisabledReason}</p>}
          {notice && <div className="notice" role="status">{notice}</div>}
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>推理结果</h2><span>{({ idle: "等待输入", running: "接收中", completed: "已完成", failed: "请求失败", uncertain: "终态待确认" })[status]}</span></div>
        <div className="panel-body text-result">
          {result.reasoning && <details open><summary>接口公开返回的思考内容</summary><pre>{result.reasoning}</pre></details>}
          <pre className="text-answer">{result.text || (busy ? "等待模型输出…" : "回答将显示在这里。")}</pre>
          <button className="secondary-button" disabled={!result.text} onClick={copyAnswer}>复制回答</button>
          {result.stopReason && <p className="text-help">结束原因：{result.stopReason}</p>}
          {result.usage && <details><summary>接口返回的实际用量</summary><pre>{JSON.stringify(result.usage, null, 2)}</pre></details>}
          {requestInfo && <div className="text-request-info"><p>本次请求标识：{requestInfo.id}</p>{requestInfo.requestId && <p>中转请求 ID：{requestInfo.requestId}</p>}{requestInfo.replayed && <p>中转已确认重放原请求，没有重新调用上游。</p>}</div>}
          <p className="text-help">不会自动重发生成。恢复使用原 Key、原参数和原标识；中转缓存最多保留 10 分钟，也可能提前失效。费用以中转消费账单为准。</p>
        </div>
      </section>
    </div>
  </main>;
}
