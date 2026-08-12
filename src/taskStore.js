const DB_NAME = "ai-video-workbench";
const DB_VERSION = 1;
const STORE_NAME = "tasks";
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
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开浏览器任务数据库"));
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

export async function putTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return;
  const database = await openTaskDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  for (const task of tasks) store.put(normalizedTask(task));
  await transactionDone(transaction);
}

export async function putTask(task) {
  return putTasks([task]);
}

export async function removeTask(id) {
  const database = await openTaskDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).delete(id);
  await transactionDone(transaction);
}

function taskMatches(task, { status = "all", query = "", projectName = "all" } = {}) {
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

async function pendingByStatus(database, status, remaining) {
  if (remaining <= 0) return [];
  const transaction = database.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("status");
  const items = [];
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(status), "next");
    request.onerror = () => reject(request.error || new Error("读取生成中任务失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || items.length >= remaining) return resolve();
      items.push(cursor.value);
      cursor.continue();
    };
  });
  return items;
}

export async function getPendingTasks(limit = 10) {
  const database = await openTaskDatabase();
  const queued = await pendingByStatus(database, "queued", limit);
  const processing = await pendingByStatus(database, "processing", limit - queued.length);
  return [...queued, ...processing];
}

export async function getFailedTasks(limit = 10) {
  const database = await openTaskDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("status");
  const items = await requestResult(index.getAll(IDBKeyRange.only("failed")));
  return items
    .sort((left, right) => Number(right.createdAtMs || 0) - Number(left.createdAtMs || 0))
    .slice(0, limit);
}

export async function allTasks() {
  const database = await openTaskDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  return requestResult(transaction.objectStore(STORE_NAME).getAll());
}

export async function projectNames() {
  const tasks = await allTasks();
  return [...new Set(tasks.map((task) => task.projectName || "未归类"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
