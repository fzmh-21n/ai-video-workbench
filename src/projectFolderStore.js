const DB_NAME = "ai-video-workbench-project-folder";
const STORE_NAME = "handles";
const CURRENT_KEY = "current-project";

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeOperation(mode, operation) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      let result;
      let operationError;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(operationError || transaction.error || new Error("素材文件夹绑定保存失败"));
      transaction.onabort = () => reject(operationError || transaction.error || new Error("素材文件夹绑定操作已取消"));
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

function storeRequest(mode, operation) {
  return storeOperation(mode, (store, setResult, onResult) => onResult(operation(store), setResult));
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

export async function loadTaskProjectDirectory(projectName, { migrateLegacy = false } = {}) {
  const key = taskProjectKey(projectName);
  if (!migrateLegacy) return (await storeRequest("readonly", (store) => store.get(key))) || null;
  return storeOperation("readwrite", (store, setResult, onResult) => {
    onResult(store.get(key), (existing) => {
      if (existing) {
        store.delete(CURRENT_KEY);
        setResult(existing);
        return;
      }
      onResult(store.get(CURRENT_KEY), (legacy) => {
        if (legacy) {
          store.put(legacy, key);
          store.delete(CURRENT_KEY);
        }
        setResult(legacy || null);
      });
    });
  });
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

export async function projectDirectoryPermission(handle, request = false) {
  if (!handle) return "denied";
  const options = { mode: "read" };
  if (await handle.queryPermission?.(options) === "granted") return "granted";
  if (request && await handle.requestPermission?.(options) === "granted") return "granted";
  return "prompt";
}

export async function filesFromProjectDirectory(handle) {
  const files = [];
  async function walk(directory, relativeDirectory = "") {
    for await (const [name, entry] of directory.entries()) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (entry.kind === "directory") await walk(entry, relativePath);
      if (entry.kind === "file") files.push({ file: await entry.getFile(), relativePath });
    }
  }
  await walk(handle);
  return files;
}
