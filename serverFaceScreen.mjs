import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export function faceScreenRouter(rootDir) {
  const router = express.Router();
  const libraryDir = path.join(rootDir, ".workbench-data", "face-library");
  const python = path.join(rootDir, ".workbench-data", "face-venv", "Scripts", "python.exe");
  const indexPath = path.join(libraryDir, "index.json");
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 60 } });
  mkdirSync(libraryDir, { recursive: true });

  function list() {
    return existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
  }

  function save(items) {
    writeFileSync(indexPath, JSON.stringify(items, null, 2));
  }

  function imageExtension(file) {
    if (file.mimetype === "image/jpeg") return ".jpg";
    if (file.mimetype === "image/png") return ".png";
    if (file.mimetype === "image/webp") return ".webp";
    return null;
  }

  router.get("/references", (_req, res) => res.json({ references: list() }));

  router.post("/references", upload.single("image"), (req, res) => {
    const name = String(req.body?.name || "").trim().slice(0, 80);
    const extension = req.file && imageExtension(req.file);
    if (!name || !extension) return res.status(400).json({ message: "请填写人物姓名并上传 JPG、PNG 或 WEBP 照片" });
    const id = crypto.randomUUID();
    writeFileSync(path.join(libraryDir, id + extension), req.file.buffer);
    const sourceUrl = String(req.body?.sourceUrl || "").trim();
    const items = [...list(), { id, name, file: id + extension, sourceUrl: /^https:\/\//.test(sourceUrl) ? sourceUrl : "" }];
    save(items);
    res.json({ references: items });
  });

  router.delete("/references/:id", (req, res) => {
    const items = list();
    const item = items.find((value) => value.id === req.params.id);
    if (!item) return res.status(404).json({ message: "参考图不存在" });
    rmSync(path.join(libraryDir, item.file), { force: true });
    const remaining = items.filter((value) => value.id !== item.id);
    save(remaining);
    res.json({ references: remaining });
  });

  router.post("/scan", upload.array("frames", 60), async (req, res) => {
    if (!existsSync(python)) return res.status(503).json({ message: "人脸分析组件尚未安装，请运行 setup-face-screen.ps1" });
    if (!req.files?.length || req.files.some((file) => !imageExtension(file))) {
      return res.status(400).json({ message: "请先选择视频并提取画面" });
    }
    let times;
    try { times = JSON.parse(String(req.body?.times || "[]")); }
    catch { return res.status(400).json({ message: "视频画面时间信息有误" }); }
    if (!Array.isArray(times) || times.length !== req.files.length || times.some((value) => !Number.isFinite(Number(value)))) {
      return res.status(400).json({ message: "视频画面时间信息有误" });
    }
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "face-screen-"));
    try {
      const frames = req.files.map((file, index) => {
        const framePath = path.join(tempDir, `${index}.jpg`);
        writeFileSync(framePath, file.buffer);
        return { path: framePath, time: Number(times[index]) };
      });
      const references = list().map((item) => ({ name: item.name, path: path.join(libraryDir, item.file) }));
      const result = await new Promise((resolve, reject) => {
        const child = spawn(python, [path.join(rootDir, "faceScreen.py")], { cwd: rootDir, windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
          try {
            const output = JSON.parse(stdout);
            if (code !== 0 || output.error) reject(new Error(output.error || stderr));
            else resolve(output);
          } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify({ frames, references }));
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: error.message || "人脸分析失败" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  return router;
}
