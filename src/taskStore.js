import { archivedUselessTask, uselessTaskBatches } from "./uselessBatches.js";
import { mergeSubmissionRecord, submissionRecord } from "./submissionRecords.js";

const DB_NAME = "ai-video-workbench";
const DB_VERSION = 2;
const STORE_NAME = "tasks";
const SUBMISSION_STORE_NAME = "submission_records";
const HISTORY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let databasePromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("浏览器数据库操作失败"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("浏览器数据库写入失败"));
    transaction.onabort = () => reject(transaction.error || new Error("浏览器数据库写入已取消"));
  });
}

export function openTaskDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "id" });
        if (!store.indexNames.contains("createdAtMs"))
          store.createIndex("createdAtMs", "createdAtMs", { unique: false });
        if (!store.indexNames.contains("status"))
          store.createIndex("status", "status", { unique: false });
        if (!store.indexNames.contains("projectName"))
          store.createIndex("projectName", "projectName", { unique: false });
        const records = database.objectStoreNames.contains(SUBMISSION_STORE_NAME)
          ? request.transaction.objectStore(SUBMISSION_STORE_NAME)
          : database.createObjectStore(SUBMISSION_STORE_NAME, { keyPath: "id" });
        if (!records.indexNames.contains("projectName"))
          records.createIndex("projectName", "projectName", { unique: false });
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          putSubmissionRecord(request.transaction, cursor.value);
          cursor.continue();
        };
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = undefined;
        };
        resolve(database);
      };
      request.onerror = () => {
        databasePromise = undefined;
        reject(request.error || new Error("无法打开浏览器任务数据库"));
      };
    });
  }
  return databasePromise;
}

function taskTimestamp(task) {
  const direct = Number(task?.createdAtMs);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(String(task?.createdAt || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizedTask(task) {
  const createdAtMs = taskTimestamp(task);
  return {
    ...task,
    createdAtMs,
    updatedAtMs: Date.now(),
    projectName: String(task?.projectName || "未归类"),
  };
}

function putSubmissionRecord(transaction, task) {
  const records = transaction.objectStore(SUBMISSION_STORE_NAME);
  const request = records.get(task.id);
  request.onsuccess = () => records.put(mergeSubmissionRecord(request.result, task));
}

function putTaskRecord(transaction, task) {
  transaction.objectStore(STORE_NAME).put(task);
  putSubmissionRecord(transaction, task);
}

export function mergeTaskDownloadState(stored, update) {
  const validTime = (value) => Number.isFinite(value) && value > 0 ? value : 0;
  const downloadedAtMs = Math.max(
    stored?.id === update?.id ? validTime(stored?.downloadedAtMs) : 0,
    validTime(update?.downloadedAtMs),
  );
  return downloadedAtMs ? { ...update, downloadedAtMs } : update;
}

export async function putTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return;
  return putTaskBackup(tasks);
}

export async function putTaskBackup(tasks = [], submissionRecords = []) {
  if (!Array.isArray(tasks) || !Array.isArray(submissionRecords)) throw new Error("任务备份格式无效");
  if (!tasks.length && !submissionRecords.length) return;
  const normalized = tasks.map(normalizedTask);
  const records = new Map();
  for (const row of [...submissionRecords, ...normalized]) {
    const record = submissionRecord(row);
    if (!record.id) throw new Error("提交台账缺少任务 ID");
    records.set(record.id, mergeSubmissionRecord(records.get(record.id), record));
  }
  const database = await openTaskDatabase();
  const transaction = database.transaction([STORE_NAME, SUBMISSION_STORE_NAME], "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  for (const task of normalized) {
    const request = store.get(task.id);
    request.onsuccess = () => store.put(mergeTaskDownloadState(request.result, task));
  }
  for (const record of records.values()) putSubmissionRecord(transaction, record);
  await transactionDone(transaction);
}

export async function putTask(task) {
  return putTasks([task]);
}

export function mergePolledTaskUpdate(stored, update) {
  if (stored?.archivedAtMs) return normalizedTask(stored);
  if (stored?.cancelledByUser && stored?.status === "failed") return normalizedTask(stored);
  const completedAt = update?.status === "completed" && stored?.status !== "completed"
    ? update.completedAt || new Date().toLocaleString("zh-CN", { hour12: false })
    : update?.completedAt;
  return normalizedTask({
    ...stored,
    ...mergeTaskDownloadState(stored, update),
    ...(completedAt ? { completedAt } : {}),
    id: stored.id,
    projectName: stored.projectName,
    title: stored.title,
    profileId: stored.profileId,
  });
}

export async function putPolledTaskUpdates(updates) {
  if (!Array.isArray(updates) || !updates.length) return;
  const database = await openTaskDatabase();
  const transaction = database.transaction([STORE_NAME, SUBMISSION_STORE_NAME], "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  for (const update of updates) {
    const request = store.get(update.id);
    request.onsuccess = () => {
      if (request.result) putTaskRecord(transaction, mergePolledTaskUpdate(request.result, update));
    };
  }
  await transactionDone(transaction);
}

export async function markTaskDownloaded(id, downloadedAtMs = Date.now()) {
  return markTasksDownloaded([id], downloadedAtMs);
}

export async function markTasksDownloaded(ids, downloadedAtMs = Date.now()) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length) return;
  if (!Number.isFinite(downloadedAtMs) || downloadedAtMs <= 0) throw new Error("下载记录时间无效");
  const database = await openTaskDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(STORE_NAME);
  let operationError;
  for (const id of uniqueIds) {
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) {
        operationError = new Error("任务记录已不存在，未能保存下载标记");
        transaction.abort();
        return;
      }
      store.put(normalizedTask(mergeTaskDownloadState(request.result, { ...request.result, downloadedAtMs })));
    };
  }
  await done.catch((error) => { throw operationError || error; });
}

export async function removeTask(id) {
  return removeTasks([id]);
}

export async function removeTasks(ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length) return;
  const database = await openTaskDatabase();
  const transaction = database.transaction([STORE_NAME, SUBMISSION_STORE_NAME], "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  for (const id of uniqueIds) {
    const request = store.get(id);
    request.onsuccess = () => {
      if (request.result) putSubmissionRecord(transaction, request.result);
      store.delete(id);
    };
  }
  await transactionDone(transaction);
}

function taskMatches(task, { status = "all", query = "", projectName = "all" } = {}) {
  if (task.archivedAtMs) return false;
  if (projectName !== "all" && task.projectName !== projectName) return false;
  if (status === "history") {
    if (task.status !== "completed" && task.status !== "failed") return false;
    if (taskTimestamp(task) > Date.now() - HISTORY_AGE_MS) return false;
  } else if (status !== "all" && task.status !== status) {
    return false;
  }
  const search = query.trim().toLowerCase();
  if (!search) return true;
  return [task.title, task.id, task.model, task.providerName, task.projectName]
    .some((value) => String(value || "").toLowerCase().includes(search));
}

export async function listTasks({ page = 1, pageSize = 10, status, query, projectName } = {}) {
  const database = await openTaskDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("createdAtMs");
  const offset = Math.max(0, (page - 1) * pageSize);
  const items = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    request.onerror = () => reject(request.error || new Error("读取任务列表失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      const task = cursor.value;
      if (taskMatches(task, { status, query, projectName })) {
        if (total >= offset && items.length < pageSize) items.push(task);
        total += 1;
      }
      cursor.continue();
    };
  });
  return { items, total };
}

async function boundedStatusTasks(database, status, limit, compare) {
  const transaction = database.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("status");
  const items = [];
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(status));
    request.onerror = () => reject(request.error || new Error("读取任务状态失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      if (!cursor.value.archivedAtMs) {
        items.push(cursor.value);
        items.sort(compare);
        if (items.length > limit) items.length = limit;
      }
      cursor.continue();
    };
  });
  return items;
}

function pendingTaskOrder(left, right) {
  return Number(left.nextPollAt || 0) - Number(right.nextPollAt || 0)
    || Number(left.updatedAtMs || left.createdAtMs || 0) - Number(right.updatedAtMs || right.createdAtMs || 0);
}

export function selectPendingTasks(tasks, limit = 10) {
  return [...tasks]
    .sort(pendingTaskOrder)
    .slice(0, limit);
}

export function isWorkbenchAuthFailure(error) {
  return /请先登录工作台/.test(String(error || ""));
}

export async function getPendingTasks(limit = 10) {
  const database = await openTaskDatabase();
  const queued = await boundedStatusTasks(database, "queued", limit, pendingTaskOrder);
  const processing = await boundedStatusTasks(database, "processing", limit, pendingTaskOrder);
  return selectPendingTasks([...queued, ...processing], limit);
}

export async function getFailedTasks(limit = 10) {
  const database = await openTaskDatabase();
  return boundedStatusTasks(database, "failed", limit,
    (left, right) => Number(right.createdAtMs || 0) - Number(left.createdAtMs || 0));
}

export async function allTasks() {
  const database = await openTaskDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  return requestResult(transaction.objectStore(STORE_NAME).getAll());
}

export async function getSubmissionRecords() {
  const database = await openTaskDatabase();
  const transaction = database.transaction(SUBMISSION_STORE_NAME, "readonly");
  return requestResult(transaction.objectStore(SUBMISSION_STORE_NAME).getAll());
}

export async function projectNames() {
  const database = await openTaskDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("projectName");
  const names = new Set();
  await new Promise((resolve, reject) => {
    const request = index.openKeyCursor(null, "nextunique");
    request.onerror = () => reject(request.error || new Error("读取任务项目失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      names.add(cursor.key || "未归类");
      cursor.continue();
    };
  });
  return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export async function getTasksByIds(ids = []) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return [];
  const database = await openTaskDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  return (await Promise.all(uniqueIds.map((id) => requestResult(store.get(id))))).filter(Boolean);
}

export async function getProjectTasks(projectName) {
  if (!projectName) return allTasks();
  const database = await openTaskDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("projectName");
  return requestResult(index.getAll(IDBKeyRange.only(projectName)));
}

export async function archiveUselessBatches(batchIds, projectName = "all") {
  const ids = new Set(batchIds);
  if (!ids.size) return { taskIds: [], batchCount: 0 };
  const database = await openTaskDatabase();
  const transaction = database.transaction([STORE_NAME, SUBMISSION_STORE_NAME], "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const candidates = [];
  const result = { taskIds: [], batchCount: 0 };
  let operationError;
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      if (ids.has(cursor.value.batchId)) candidates.push(cursor.value);
      cursor.continue();
      return;
    }
    try {
      const eligible = uselessTaskBatches(candidates, projectName);
      const archivedAtMs = Date.now();
      for (const batch of eligible) for (const task of batch.tasks) {
        putTaskRecord(transaction, archivedUselessTask(task, archivedAtMs));
        result.taskIds.push(task.id);
      }
      result.batchCount = eligible.length;
    } catch (error) {
      operationError = error;
      transaction.abort();
    }
  };
  await transactionDone(transaction).catch((error) => { throw operationError || error; });
  return result;
}

export async function renameTaskProjectRecords(oldName, newName) {
  const previous = String(oldName || "").trim();
  const next = String(newName || "").trim();
  if (!previous || !next) throw new Error("项目名称不能为空");
  if (previous === "未归类" || next === "未归类") throw new Error("不能更改为或更改“未归类”项目名称");
  if (previous === next) return 0;
  const database = await openTaskDatabase();
  const transaction = database.transaction([STORE_NAME, SUBMISSION_STORE_NAME], "readwrite");
  const done = transactionDone(transaction);
  let count = 0;
  let operationError;
  try {
    for (const storeName of [STORE_NAME, SUBMISSION_STORE_NAME]) {
      const request = transaction.objectStore(storeName).index("projectName").openCursor(IDBKeyRange.only(previous));
      request.onerror = () => {
        operationError = request.error;
        transaction.abort();
      };
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          const renamed = { ...cursor.value, projectName: next };
          cursor.update(renamed);
          if (storeName === STORE_NAME) {
            putSubmissionRecord(transaction, renamed);
            count += 1;
          }
          cursor.continue();
        } catch (error) {
          operationError = error;
          transaction.abort();
        }
      };
    }
  } catch (error) {
    operationError = error;
    transaction.abort();
  }
  await done.catch((error) => { throw operationError || error; });
  return count;
}
