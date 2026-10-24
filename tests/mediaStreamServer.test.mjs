import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const start = source.indexOf("function streamResponse(response, res)");
const handler = source.slice(start, source.indexOf("function sameSiteHost", start));

function run(scenario) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { Readable, Writable, pipeline } from "node:stream";
    import { createServer } from "node:http";
    const diagnostics = [];
    function writeDiagnostic(req, stage, details) { diagnostics.push({ stage, ...details }); }
    ${handler}
    const scenario = ${JSON.stringify(scenario)};
    let cancelled = false;
    let downloadSucceeded = false;
    let bytes = 0;
    let receivedHeaders = {};
    let receivedStatus;
    if (scenario === "destination-error") {
      const res = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error("disk/socket failure"), { code: "EPIPE" })); } });
      res.req = {};
      res.status = () => res;
      res.setHeader = () => {};
      streamResponse(new Response("binary-media"), res);
      await new Promise(resolve => setTimeout(resolve, 70));
      console.log(JSON.stringify({ alive: true, diagnostics }));
    } else {
      const server = createServer((req, res) => {
        if (req.url === "/health") { res.end("ok"); return; }
        res.status = value => { res.statusCode = value; return res; };
        const media = new Uint8Array([0, 1, 2, 255, 128, 10, 42, 43, 44, 45, 46, 47]);
        const headers = { "content-type": scenario === "image" ? "image/png" : "video/mp4" };
        if (["video", "image", "range"].includes(scenario)) {
          headers["content-length"] = String(media.length);
          headers["content-disposition"] = "attachment; filename=chapter-01.mp4";
        }
        if (scenario === "range") {
          headers["content-range"] = "bytes 0-11/24";
          headers["accept-ranges"] = "bytes";
        }
        if (scenario === "partial-timeout") headers["content-length"] = "999";
        const body = scenario === "empty" ? null : new ReadableStream({
          start(controller) {
            if (["video", "image", "range"].includes(scenario)) { controller.enqueue(media); controller.close(); return; }
            if (["partial-timeout", "client-cancel"].includes(scenario)) controller.enqueue(media);
            if (scenario === "client-cancel") return;
            setTimeout(() => controller.error(scenario === "socket-error"
              ? Object.assign(new Error("socket lost: mock-secret-must-not-be-logged"), { code: "ECONNRESET" })
              : new DOMException("The operation was aborted due to timeout", "TimeoutError")), 25);
          },
          cancel() { cancelled = true; },
        });
        streamResponse(new Response(body, { status: scenario === "range" ? 206 : 200, headers }), res);
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const url = "http://127.0.0.1:" + server.address().port;
      const abort = new AbortController();
      try {
        const response = await fetch(url + "/media", { signal: abort.signal });
        receivedStatus = response.status;
        receivedHeaders = Object.fromEntries(response.headers);
        if (scenario === "client-cancel") {
          const reader = response.body.getReader();
          await reader.read();
          abort.abort();
          await reader.read();
        } else { bytes = (await response.arrayBuffer()).byteLength; downloadSucceeded = true; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 70));
      const health = await fetch(url + "/health");
      const healthy = health.status === 200 && await health.text() === "ok";
      await new Promise(resolve => server.close(resolve));
      console.log(JSON.stringify({ healthy, cancelled, downloadSucceeded, bytes, receivedStatus, receivedHeaders, diagnostics }));
    }
  `], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(child.status, 0, `A media failure must not terminate the server process:\n${child.stderr || child.error}`);
  return JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
}

for (const scenario of ["timeout", "partial-timeout", "socket-error"]) {
  test(`${scenario} affects only this transfer, rejects truncated download and leaves health responding`, () => {
    const result = run(scenario);
    assert.equal(result.healthy, true);
    assert.equal(result.downloadSucceeded, false);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].stage, "media_stream_failed");
    assert.ok(!JSON.stringify(result.diagnostics).includes("mock-secret"));
  });
}
test("closing a preview/download cancels the upstream body without crashing or leaking its stream", () => {
  const result = run("client-cancel");
  assert.equal(result.healthy, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.downloadSucceeded, false);
  assert.equal(result.diagnostics[0].stage, "media_stream_cancelled");
});
test("destination socket errors are request-scoped rather than unhandled process errors", () => {
  const result = run("destination-error");
  assert.equal(result.alive, true);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].stage, "media_stream_failed");
});
for (const scenario of ["video", "image", "range"]) {
  test(`normal ${scenario} preserves complete bytes, content headers and status`, () => {
    const result = run(scenario);
    assert.equal(result.healthy, true);
    assert.equal(result.downloadSucceeded, true);
    assert.equal(result.bytes, 12);
    assert.equal(result.receivedHeaders["content-length"], "12");
    assert.equal(result.receivedHeaders["content-type"], scenario === "image" ? "image/png" : "video/mp4");
    assert.equal(result.receivedStatus, scenario === "range" ? 206 : 200);
    if (scenario === "range") {
      assert.equal(result.receivedHeaders["content-range"], "bytes 0-11/24");
      assert.equal(result.receivedHeaders["accept-ranges"], "bytes");
    }
    assert.deepEqual(result.diagnostics, []);
  });
}
test("empty upstream body ends the response normally without a dangling stream", () => {
  const result = run("empty");
  assert.equal(result.healthy, true);
  assert.equal(result.bytes, 0);
  assert.deepEqual(result.diagnostics, []);
});
