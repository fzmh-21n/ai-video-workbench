export function seedanceSubmissionKey(item) {
  return String(item?.lastSubmission?.idempotencyKey || item?.error?.match(/幂等编号：([0-9a-f-]{36})/i)?.[1] || "");
}

export function seedanceSubmissionJournal(text) {
  const submissions = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.idempotencyKey) submissions.set(row.idempotencyKey, { ...submissions.get(row.idempotencyKey), ...row });
  }
  return submissions;
}

function timestamp(value) {
  return typeof value === "number" ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value);
}

export function seedanceReplayAllowed(submission, now = Date.now()) {
  const age = now - timestamp(submission.createdAt);
  return submission.baseUrl === "https://772808.xyz" && !submission.stopReplay
    && ["TimeoutError", "AbortError", "TypeError"].includes(submission.connectionError)
    && age >= 0 && age < 24 * 60 * 60 * 1000
    && Boolean(submission.request?.model && submission.request?.input?.prompt);
}

export function matchSeedanceSubmission(submission, tasks) {
  if (submission.taskId) return { taskId: submission.taskId };
  const request = submission.request;
  if (!request?.input?.prompt) return { reason: "缺少原始提交快照，不能安全匹配" };
  const start = timestamp(submission.createdAt);
  const matches = tasks.filter((task) => {
    if (!task?.id || task.model !== request.model) return false;
    const key = task.idempotency_key || task.idempotencyKey;
    if (key) return key === submission.idempotencyKey;
    const created = timestamp(task.created_at || task.createdAt);
    if (!Number.isFinite(created) || created < start - 2000 || created > start + 180000) return false;
    if (String(task.input?.prompt ?? task.prompt ?? "").replace(/\r\n/g, "\n") !== request.input.prompt.replace(/\r\n/g, "\n")) return false;
    const parameters = task.parameters || task;
    for (const name of ["duration", "resolution", "ratio"]) {
      if (parameters[name] != null && String(parameters[name]) !== String(request.parameters?.[name])) return false;
    }
    if (task.input?.media && JSON.stringify(task.input.media) !== JSON.stringify(request.input.media || [])) return false;
    return true;
  });
  if (matches.length !== 1) return { reason: matches.length ? "有多个相同请求的后台任务，不能猜测关联" : "后台未找到唯一对应任务，仍需核实；未重新提交" };
  return { taskId: matches[0].id };
}

export async function seedanceTaskHistory(baseUrl, getJson) {
  const tasks = [];
  const cursors = new Set();
  let cursor = "";
  for (let page = 0; page < 100; page += 1) {
    const url = `${baseUrl}/v1/videos?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = await getJson(url);
    const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.tasks) ? body.tasks : null;
    if (!rows) throw new Error("中转任务记录格式无法识别，未更改待确认任务");
    tasks.push(...rows);
    if (!body.has_more) return tasks;
    const next = String(body.next_cursor || "");
    if (!next || cursors.has(next)) throw new Error("中转任务记录分页不完整，未更改待确认任务");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("中转任务记录超过核对上限，未更改待确认任务");
}
