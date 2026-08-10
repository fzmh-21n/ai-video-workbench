import assert from "node:assert/strict";
import test from "node:test";

import {
  clearCredentials,
  readCredentials,
  saveCredentials,
} from "../src/credentialStore.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("keeps unremembered provider credentials in session storage only", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  saveCredentials("provider-a", { apiKey: " sk-session ", mediaKey: " upload-session ", remember: false }, local, session);

  assert.deepEqual(readCredentials("provider-a", local, session), {
    apiKey: "sk-session",
    mediaKey: "upload-session",
    remember: false,
  });
  assert.equal(local.getItem("video-api-key:provider-a"), null);
});

test("remembers credentials independently for each provider", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  saveCredentials("provider-a", { apiKey: "key-a", remember: true }, local, session);
  saveCredentials("provider-b", { apiKey: "key-b", remember: false }, local, session);

  assert.deepEqual(readCredentials("provider-a", local, session), {
    apiKey: "key-a",
    mediaKey: "",
    remember: true,
  });
  assert.deepEqual(readCredentials("provider-b", local, session), {
    apiKey: "key-b",
    mediaKey: "",
    remember: false,
  });
});

test("switching remember off moves a persistent key back to the session", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  saveCredentials("provider-a", { apiKey: "key-a", remember: true }, local, session);
  saveCredentials("provider-a", { apiKey: "key-a", remember: false }, local, session);

  assert.equal(local.getItem("video-api-key:provider-a"), null);
  assert.equal(session.getItem("video-api-key:provider-a"), "key-a");
  assert.equal(readCredentials("provider-a", local, session).remember, false);
});

test("deleting a provider clears its local and session credentials", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  saveCredentials("provider-a", { apiKey: "key-a", mediaKey: "media-a", remember: true }, local, session);
  clearCredentials("provider-a", local, session);

  assert.deepEqual(readCredentials("provider-a", local, session), {
    apiKey: "",
    mediaKey: "",
    remember: false,
  });
});
