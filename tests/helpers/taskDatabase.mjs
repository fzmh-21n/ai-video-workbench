import assert from "node:assert/strict";
import { submissionRecord } from "../../src/submissionRecords.js";

const copy = (value) => value === undefined ? undefined : structuredClone(value);

export function taskDatabase(tasks = [], options = {}) {
  let version = options.version ?? 2;
  let data = new Map([["tasks", new Map(tasks.map((task) => [task.id, copy(task)]))]]);
  if (version >= 2) data.set("submission_records", new Map((options.records ?? tasks.map(submissionRecord)).map((row) => [row.id, copy(row)])));
  let indexes = new Map([...data.keys()].map((name) => [name, new Set(name === "tasks" ? ["createdAtMs", "status", "projectName"] : ["projectName"])]));
  const stats = { modes: [], transactions: [], indexReads: [], updates: 0, puts: 0, putCount: 0, commits: 0, aborts: 0, opens: 0, closes: 0 };
  let upgrade;
  function transaction(names, mode, onComplete, onAbort) {
    const selected = Array.isArray(names) ? names : [names];
    const operations = [];
    stats.modes.push(mode);
    stats.transactions.push({ names: selected, mode, operations });
    const draft = new Map([...data].map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, copy(row)]))]));
    const draftIndexes = new Map([...indexes].map(([name, values]) => [name, new Set(values)]));
    const writes = new Map();
    let pending = 0;
    let closed = false;
    const result = {
      objectStore(name) {
        assert.ok(mode === "versionchange" || selected.includes(name), `${name} must belong to the transaction`);
        assert.ok(draft.has(name), `${name} must exist`);
        return store(name);
      },
      hasStore: (name) => draft.has(name),
      addStore(name) { draft.set(name, new Map()); draftIndexes.set(name, new Set()); return store(name); },
      abort() {
        if (closed) return;
        closed = true;
        stats.aborts += 1;
        setImmediate(() => { result.onabort?.(); onAbort?.(result.error); });
      },
      finish() {
        setImmediate(() => {
          if (closed || pending) return;
          closed = true;
          if (mode !== "readonly") { data = draft; indexes = draftIndexes; stats.commits += 1; }
          result.oncomplete?.();
          onComplete?.();
        });
      },
    };
    function deliver(request, value, error) {
      pending += 1;
      setImmediate(() => {
        if (closed) return;
        if (error) {
          request.error = result.error = error;
          request.onerror?.();
          result.onerror?.();
          result.abort();
          return;
        }
        try { request.result = value(); request.onsuccess?.(); }
        catch (error) { result.error = error; result.abort(); }
        pending -= 1;
        if (!pending) result.finish();
      });
      return request;
    }
    function store(name) {
      const rows = draft.get(name);
      const write = (type, value) => {
        const key = `${name}:${type}`;
        writes.set(key, (writes.get(key) || 0) + 1);
        if (name === "tasks" && type === "put") stats.putCount = ++stats.puts;
        if (name === "tasks" && type === "update") stats.updates += 1;
        const failure = options.failOperation;
        const fails = (failure?.store === name && failure.type === type && writes.get(key) === (failure.at || 1))
          || (name === "tasks" && type === "put" && stats.puts === options.failPutAt)
          || (name === "tasks" && type === "update" && stats.updates === options.failUpdateAt);
        const error = fails ? new Error(options.errorMessage || "模拟数据库写入失败") : null;
        if (error && (failure?.synchronous || options.synchronousPutFailure || options.synchronousUpdateFailure)) throw error;
        const id = type === "delete" ? value : value.id;
        operations.push({ store: name, type, id });
        return deliver({}, () => {
          if (type === "delete") rows.delete(id);
          else rows.set(id, copy(value));
          return id;
        }, error);
      };
      const cursor = (values) => {
        const request = {};
        let position = 0;
        const advance = () => {
          const value = values[position++];
          const error = name === "tasks" && position === options.failCursorAt ? new Error("模拟项目游标读取失败") : null;
          return deliver(request, () => value ? {
            value: copy(value), continue: advance, update: (value) => write("update", value),
          } : null, error);
        };
        advance();
        return request;
      };
      return {
        indexNames: { contains: (indexName) => draftIndexes.get(name).has(indexName) },
        createIndex(indexName) { draftIndexes.get(name).add(indexName); },
        get(id) { operations.push({ store: name, type: "get", id }); return deliver({}, () => copy(rows.get(id))); },
        getAll: () => deliver({}, () => copy([...rows.values()])),
        put: (value) => write("put", value), delete: (id) => write("delete", id),
        openCursor: () => cursor([...rows.values()]),
        index(indexName) {
          assert.ok(draftIndexes.get(name).has(indexName), `${name}.${indexName} index must exist`);
          return { openCursor(key, direction) {
            stats.indexReads.push({ store: name, name: indexName, key });
            let values = [...rows.values()].filter((row) => key == null || row[indexName] === key);
            values.sort((left, right) => left[indexName] < right[indexName] ? -1 : left[indexName] > right[indexName] ? 1 : 0);
            if (direction === "prev") values.reverse();
            return cursor(values);
          } };
        },
      };
    }
    return result;
  }
  const database = {
    objectStoreNames: { contains: (name) => upgrade ? upgrade.hasStore(name) : data.has(name) },
    createObjectStore: (name) => upgrade.addStore(name),
    transaction: (names, mode) => transaction(names, mode),
    close() { stats.closes += 1; },
  };
  const indexedDB = { open(_name, nextVersion) {
    stats.opens += 1;
    const request = {};
    setImmediate(() => {
      request.result = database;
      if (nextVersion > version) {
        upgrade = transaction([...data.keys()], "versionchange", () => {
          version = nextVersion; upgrade = undefined; request.onsuccess?.();
        }, (error) => { upgrade = undefined; request.error = error; request.onerror?.(); });
        request.transaction = upgrade;
        try { request.onupgradeneeded?.({ oldVersion: version, newVersion: nextVersion }); }
        catch (error) { upgrade.error = error; upgrade.abort(); }
        upgrade.finish();
      } else request.onsuccess?.();
    });
    return request;
  } };
  return { database, indexedDB, stats, insert: (task) => data.get("tasks").set(task.id, copy(task)) };
}
