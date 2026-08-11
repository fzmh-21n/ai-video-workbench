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

async function storeRequest(mode, operation) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function saveProjectDirectory(handle) {
  return storeRequest("readwrite", (store) => store.put(handle, CURRENT_KEY));
}

export function loadProjectDirectory() {
  return storeRequest("readonly", (store) => store.get(CURRENT_KEY));
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
