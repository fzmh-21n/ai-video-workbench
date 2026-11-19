const DB_NAME = "ai-video-workbench-project-folder";
const STORE_NAME = "handles";
const CURRENT_KEY = "current-project";

function reportDiagnostic(onDiagnostic, stage, details = {}) {
  if (!onDiagnostic) return;
  try { onDiagnostic({ stage, ...details })?.catch?.(() => {}); } catch {}
}

function database(onDiagnostic) {
  return new Promise((resolve, reject) => {
    reportDiagnostic(onDiagnostic, "project_folder_db_open_started");
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch (error) {
      reportDiagnostic(onDiagnostic, "project_folder_db_open_failed");
      throw error;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      reportDiagnostic(onDiagnostic, "project_folder_db_open_completed");
      resolve(request.result);
    };
    request.onerror = () => {
      reportDiagnostic(onDiagnostic, "project_folder_db_open_failed");
      reject(request.error);
    };
    request.onblocked = () => reportDiagnostic(onDiagnostic, "project_folder_db_open_blocked");
  });
}

async function storeOperation(mode, operation, onDiagnostic) {
  const db = await database(onDiagnostic);
  try {
    return await new Promise((resolve, reject) => {
      reportDiagnostic(onDiagnostic, "project_folder_transaction_started", { mode });
      let transaction;
      try {
        transaction = db.transaction(STORE_NAME, mode);
      } catch (error) {
        reportDiagnostic(onDiagnostic, "project_folder_transaction_failed", { mode });
        throw error;
      }
      let result;
      let operationError;
      transaction.oncomplete = () => {
        reportDiagnostic(onDiagnostic, "project_folder_transaction_completed", { mode });
        resolve(result);
      };
      transaction.onerror = () => {
        reportDiagnostic(onDiagnostic, "project_folder_transaction_failed", { mode });
        reject(operationError || transaction.error || new Error("素材文件夹绑定保存失败"));
      };
      transaction.onabort = () => {
        reportDiagnostic(onDiagnostic, "project_folder_transaction_aborted", { mode });
        reject(operationError || transaction.error || new Error("素材文件夹绑定操作已取消"));
      };
      const abort = (error) => {
        operationError = error;
        transaction.abort();
      };
      const onResult = (request, callback) => {
        request.onerror = () => abort(request.error);
        request.onsuccess = () => {
          try { callback(request.result); } catch (error) { abort(error); }
        };
      };
      try {
        operation(transaction.objectStore(STORE_NAME), (value) => { result = value; }, onResult);
      } catch (error) {
        abort(error);
      }
    });
  } finally {
    db.close();
  }
}

function storeRequest(mode, operation, onDiagnostic) {
  return storeOperation(mode, (store, setResult, onResult) => {
    if (mode === "readonly") reportDiagnostic(onDiagnostic, "project_folder_binding_read_started");
    onResult(operation(store), (result) => {
      if (mode === "readonly") reportDiagnostic(onDiagnostic, "project_folder_binding_read_completed", { found: !!result });
      setResult(result);
    });
  }, onDiagnostic);
}

export function saveProjectDirectory(handle) {
  return storeRequest("readwrite", (store) => store.put(handle, CURRENT_KEY));
}

export function loadProjectDirectory() {
  return storeRequest("readonly", (store) => store.get(CURRENT_KEY));
}

function taskProjectKey(projectName) {
  const name = String(projectName || "").trim();
  if (!name) throw new Error("项目名称不能为空");
  return `task-project:${JSON.stringify(name)}`;
}

export async function saveTaskProjectDirectory(projectName, handle) {
  const key = taskProjectKey(projectName);
  return storeRequest("readwrite", (store) => store.put(handle, key));
}

export async function loadTaskProjectDirectory(projectName, { migrateLegacy = false, onDiagnostic } = {}) {
  const key = taskProjectKey(projectName);
  if (!migrateLegacy) return (await storeRequest("readonly", (store) => store.get(key), onDiagnostic)) || null;
  return storeOperation("readwrite", (store, setResult, onResult) => {
    reportDiagnostic(onDiagnostic, "project_folder_binding_read_started");
    onResult(store.get(key), (existing) => {
      reportDiagnostic(onDiagnostic, "project_folder_binding_read_completed", { found: !!existing });
      if (existing) {
        store.delete(CURRENT_KEY);
        setResult(existing);
        return;
      }
      reportDiagnostic(onDiagnostic, "project_folder_legacy_read_started");
      onResult(store.get(CURRENT_KEY), (legacy) => {
        reportDiagnostic(onDiagnostic, "project_folder_legacy_read_completed", { found: !!legacy });
        if (legacy) {
          store.put(legacy, key);
          store.delete(CURRENT_KEY);
        }
        setResult(legacy || null);
      });
    });
  }, onDiagnostic);
}

export async function renameTaskProjectDirectory(oldName, newName) {
  const previous = String(oldName || "").trim();
  const next = String(newName || "").trim();
  const oldKey = taskProjectKey(previous);
  const newKey = taskProjectKey(next);
  if ([previous, next].some((name) => name === "未归类" || name === "all")) throw new Error("不能更改系统项目的文件夹绑定名称");
  if (oldKey === newKey) return false;
  return storeOperation("readwrite", (store, setResult, onResult) => {
    onResult(store.get(oldKey), (source) => {
      if (!source) return setResult(false);
      onResult(store.get(newKey), (target) => {
        if (target) throw new Error("新项目已绑定素材文件夹，不能覆盖");
        store.put(source, newKey);
        store.delete(oldKey);
        setResult(true);
      });
    });
  });
}

export async function removeTaskProjectDirectory(projectName) {
  const key = taskProjectKey(projectName);
  return storeRequest("readwrite", (store) => store.delete(key));
}

export async function projectDirectoryPermission(handle, request = false, onDiagnostic) {
  if (!handle) return "denied";
  const options = { mode: "read" };
  if (request && typeof handle.requestPermission === "function") {
    reportDiagnostic(onDiagnostic, "project_folder_permission_request_started");
    const requested = await handle.requestPermission(options);
    reportDiagnostic(onDiagnostic, "project_folder_permission_request_completed", { permission: requested });
    return requested === "granted" ? "granted" : "prompt";
  }
  reportDiagnostic(onDiagnostic, "project_folder_permission_query_started");
  let timer;
  try {
    const queried = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reportDiagnostic(onDiagnostic, "project_folder_permission_query_timeout");
        reject(Object.assign(new Error("浏览器查询文件夹读取权限超时；原绑定已保留，请恢复或重新选择文件夹"), {
          name: "TimeoutError",
          code: "PROJECT_FOLDER_PERMISSION_TIMEOUT",
        }));
      }, 10_000);
      Promise.resolve(handle.queryPermission?.(options)).then(resolve, reject);
    });
    reportDiagnostic(onDiagnostic, "project_folder_permission_query_completed", { permission: queried });
    return queried === "granted" ? "granted" : "prompt";
  } finally {
    clearTimeout(timer);
  }
}

export async function filesFromProjectDirectory(handle, onDiagnostic) {
  const files = [];
  let directoryCount = 0;
  const progress = (stage) => reportDiagnostic(onDiagnostic, stage, { fileCount: files.length, directoryCount });
  progress("project_folder_scan_started");
  async function walk(directory, relativeDirectory = "") {
    directoryCount += 1;
    progress("project_folder_scan_directory_started");
    for await (const [name, entry] of directory.entries()) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (entry.kind === "directory") await walk(entry, relativePath);
      if (entry.kind === "file") {
        progress("project_folder_scan_file_started");
        files.push({ file: await entry.getFile(), relativePath });
        if (files.length % 25 === 0) progress("project_folder_scan_progress");
      }
      progress("project_folder_scan_directory_started");
    }
  }
  await walk(handle);
  progress("project_folder_scan_completed");
  return files;
}
