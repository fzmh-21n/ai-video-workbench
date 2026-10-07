import React, { useEffect, useState } from "react";

function formatTime(seconds) {
  const value = Math.floor(seconds);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

async function readResponse(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || "操作失败");
  return body;
}

async function sampleVideo(file, onProgress) {
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.src = url;
  video.muted = true;
  video.preload = "auto";
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("无法读取这个视频"));
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("无法读取视频时长");
    const count = Math.min(60, Math.max(1, Math.ceil(video.duration)));
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const frames = [];
    const times = [];
    for (let index = 0; index < count; index += 1) {
      const time = Math.min(video.duration - 0.01, (index + 0.5) * video.duration / count);
      await new Promise((resolve, reject) => {
        video.onseeked = resolve;
        video.onerror = () => reject(new Error("视频画面读取失败"));
        video.currentTime = time;
      });
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      if (!blob) throw new Error("视频画面提取失败");
      frames.push(blob);
      times.push(Math.round(time * 10) / 10);
      onProgress(index + 1, count);
    }
    return { frames, times };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export default function FaceScreen({ onVideoMode, onImageMode, onLogout }) {
  const [references, setReferences] = useState([]);
  const [referenceSearch, setReferenceSearch] = useState("");
  const [name, setName] = useState("");
  const [referenceFile, setReferenceFile] = useState(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [videoFiles, setVideoFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState([]);
  const matchingReferences = references.filter((item) => item.name.includes(referenceSearch.trim()));

  useEffect(() => {
    fetch("/api/face-screen/references").then(readResponse)
      .then((body) => setReferences(body.references))
      .catch((issue) => setError(issue.message));
  }, []);

  async function addReference(event) {
    event.preventDefault();
    setError("");
    const form = new FormData();
    form.append("name", name);
    form.append("image", referenceFile);
    form.append("sourceUrl", sourceUrl);
    try {
      const body = await readResponse(await fetch("/api/face-screen/references", { method: "POST", body: form }));
      setReferences(body.references);
      setReferenceFile(null);
      setSourceUrl("");
    } catch (issue) { setError(issue.message); }
  }

  async function removeReference(id) {
    try {
      const body = await readResponse(await fetch(`/api/face-screen/references/${id}`, { method: "DELETE" }));
      setReferences(body.references);
    } catch (issue) { setError(issue.message); }
  }

  function addVideos(files) {
    if (busy) return;
    const selected = Array.from(files || []).filter((file) => /\.(mp4|mov|webm)$/i.test(file.name));
    if (selected.length) setResults([]);
    setVideoFiles((current) => {
      const known = new Set(current.map((file) => `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`));
      return [...current, ...selected.filter((file) => {
        const key = `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
        if (known.has(key)) return false;
        known.add(key);
        return true;
      })];
    });
  }

  async function scan() {
    if (!videoFiles.length) return;
    setBusy(true);
    setError("");
    setResults([]);
    for (const [index, file] of videoFiles.entries()) {
      const title = file.webkitRelativePath || file.name;
      try {
        const { frames, times } = await sampleVideo(file, (done, total) => setProgress(`第 ${index + 1}/${videoFiles.length} 个：提取画面 ${done}/${total}`));
        setProgress(`第 ${index + 1}/${videoFiles.length} 个：正在比较人脸…`);
        const form = new FormData();
        frames.forEach((frame, frameIndex) => form.append("frames", frame, `frame-${frameIndex}.jpg`));
        form.append("times", JSON.stringify(times));
        const result = await readResponse(await fetch("/api/face-screen/scan", { method: "POST", body: form }));
        setResults((current) => [...current, { title, result }]);
      } catch (issue) {
        setResults((current) => [...current, { title, error: issue.message }]);
      }
    }
    setProgress("");
    setBusy(false);
  }

  return <main className="workspace-shell face-screen">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">脸</span><div><h1>明星脸初筛</h1><p>本地抽帧与人脸比对 · 结果供人工复核</p></div></div>
      <div className="provider-switcher">
        <button className="secondary-button" onClick={onVideoMode}>视频生成</button>
        <button className="secondary-button" onClick={onImageMode}>图片生成</button>
        <button className="logout-button" onClick={onLogout}>退出登录</button>
      </div>
    </header>
    <div className="face-layout">
      <section className="panel"><div className="panel-heading"><h2>1. 参考人物库</h2><span>{references.length} 张照片</span></div>
        <div className="panel-body">
          <p>添加要重点排查的明星照片。每人建议放几张不同角度的清晰正脸；同名照片会合并到同一候选人。</p>
          <form className="face-controls" onSubmit={addReference}>
            <input aria-label="人物姓名" placeholder="人物姓名，例如：谭松韵" value={name} onChange={(event) => setName(event.target.value)} required />
            <input aria-label="参考照片" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setReferenceFile(event.target.files[0] || null)} required />
            <input aria-label="照片来源" placeholder="照片来源链接（可选）" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} />
            <button className="secondary-button" disabled={!referenceFile || !name.trim()}>添加照片</button>
          </form>
          <input className="face-reference-search" aria-label="搜索参考人物" placeholder="搜索库中人物" value={referenceSearch} onChange={(event) => setReferenceSearch(event.target.value)} />
          <p>显示 {Math.min(matchingReferences.length, 100)} / {matchingReferences.length} 条匹配照片</p>
          <div className="face-reference-list">{matchingReferences.slice(0, 100).map((item) => <div key={item.id}><span>{item.name}</span>{item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">来源</a>}<button type="button" onClick={() => removeReference(item.id)}>删除</button></div>)}</div>
        </div>
      </section>
      <section className="panel"><div className="panel-heading"><h2>2. 检查视频</h2><span>最多抽取 60 帧</span></div>
        <div className="panel-body">
          <p>选择多个本机视频，或一次选择整集文件夹。切到视频或图片生成时会继续筛查；刷新或关闭网页会中断。画面只上传到本地工作台服务。</p>
          <div className="face-controls">
            <label className="secondary-button file-button">选择视频文件<input aria-label="待检查视频" type="file" multiple hidden disabled={busy} accept="video/mp4,video/quicktime,video/webm,.mov,.mp4,.webm" onChange={(event) => { addVideos(event.target.files); event.target.value = ""; }} /></label>
            <label className="secondary-button file-button">选择视频文件夹<input aria-label="待检查视频文件夹" type="file" multiple hidden disabled={busy} webkitdirectory="" directory="" onChange={(event) => { addVideos(event.target.files); event.target.value = ""; }} /></label>
            <button className="primary-button" disabled={!videoFiles.length || busy} onClick={scan}>{busy ? progress : `开始初筛（${videoFiles.length} 个）`}</button>
            <button className="secondary-button" disabled={!videoFiles.length || busy} onClick={() => { setVideoFiles([]); setResults([]); }}>清空选择</button>
          </div>
          {!!videoFiles.length && <p className="face-video-list">已选 {videoFiles.length} 个视频：{videoFiles.map((file) => file.webkitRelativePath || file.name).join("、")}</p>}
          {error && <div className="login-error" role="alert">{error}</div>}
        </div>
      </section>
    </div>
    {!!results.length && <section className="panel face-results"><div className="panel-heading"><h2>筛查结果</h2><span>已完成 {results.length} / {videoFiles.length} 个视频</span></div>
      <div className="panel-body">
        <p>相似度仅用于排序，不能表示侵权概率或平台通过率。未命中也不能保证通过审核。</p>
        {results.map(({ title, result, error }, resultIndex) => <div className="face-video-result" key={`${title}-${resultIndex}`}>
          <h3>{title}</h3>
          {error ? <p className="face-warning">检查失败：{error}</p> : <>
          <p>检查 {result.framesChecked} 帧 · 发现 {result.groups.length} 组人脸</p>
        {result.invalidReferences.length > 0 && <p className="face-warning">这些参考图未检测到恰好一张清晰人脸，已跳过：{result.invalidReferences.join("、")}</p>}
        {result.groups.length === 0 ? <p>抽取的画面中没有检测到足够清晰的人脸。可人工检查未抽到的短镜头。</p> :
          <div className="face-groups">{result.groups.map((group, index) => <article key={index} className="face-group">
            <img src={`data:image/jpeg;base64,${group.image}`} alt={`检测到的人脸 ${index + 1}`} />
            <div><strong>画面人物 {index + 1}</strong><p>出现时间：{group.times.map(formatTime).join("、")}</p>
              {group.matches.length ? <p>相似候选：{group.matches.map((match) => `${match.name} ${match.score.toFixed(3)}`).join("；")}</p> : <p>参考人物库为空，暂无法比较明星脸。</p>}
            </div>
          </article>)}</div>}
          </>}
        </div>)}
      </div>
    </section>}
  </main>;
}
