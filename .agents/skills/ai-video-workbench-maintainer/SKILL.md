---
name: ai-video-workbench-maintainer
description: Maintain, diagnose, test, and modify the fzmh-21n/ai-video-workbench React and Express project. Use when the user asks to inspect or fix workbench bugs, change a relay API provider or model adapter, repair model discovery, uploads, task polling, video result handling, one-click project references, IndexedDB task storage, or the workbench UI.
---

# AI Video Workbench Maintainer

Maintain `fzmh-21n/ai-video-workbench` as the canonical source repository for the user's AI 漫剧/视频生成工作台.

## Resolve the repository

1. Use the connected GitHub repository `fzmh-21n/ai-video-workbench` when repository metadata or remote files are needed.
2. Reuse the current local checkout when it points to that repository. Otherwise clone it into the writable workspace.
3. Read any `AGENTS.md` before editing. Inspect `git status` and preserve unrelated user changes.
4. Pull or fetch only when doing so will not overwrite local work. Never expose or commit API keys.

## Map the problem

Use the smallest relevant surface first:

- `src/App.jsx`: main interface, provider management, generation flow, polling, and result presentation.
- `src/providerCatalog.js`: provider presets, model capabilities, request conventions, and compatibility rules.
- `src/projectReferences.js`: project-folder matching and `@ImageN` / `@AudioN` reference conversion.
- `src/taskStore.js`: IndexedDB task persistence, backup import/export, filtering, and pagination.
- `server.mjs`: local API proxy, provider adapters, uploads, task status normalization, and video retrieval.
- `src/styles.css`: layout and visual defects.
- `vite.config.js`: local development and build behavior.

Search the actual code before assuming an adapter's request or response schema. When a provider is involved, ask for or inspect a redacted request, response, browser console error, and server log if the repository alone cannot establish the failure.

## Diagnose and implement

1. Reproduce the reported behavior when safe and possible.
2. Trace the full path: UI input -> normalized settings -> server request -> provider response -> stored task -> polling -> rendered or downloaded video.
3. Identify the root cause and state the intended behavior before changing code.
4. Apply the smallest coherent fix. Preserve existing providers and backward-compatible saved configurations unless the user requests a migration.
5. Keep API keys in session/runtime storage. Do not add keys, secrets, private upload URLs, generated media, logs, `.workbench-data`, or `node_modules` to Git.
6. Do not retry an ambiguous video-creation POST automatically because doing so can cause duplicate billing.
7. Normalize provider-specific errors into actionable UI messages without hiding the original safe error detail.
8. If source changes affect the shipped production bundle, rebuild `dist/` and include the matching generated changes already tracked by the repository.

## Verify

Run the repository's declared package-manager workflow. Prefer the existing lockfile already used by the checkout and avoid rewriting the other lockfile unnecessarily.

At minimum:

1. Install dependencies with a frozen or clean lockfile mode when available.
2. Run `npm run build` or the equivalent declared build command.
3. Run any targeted tests or checks added for the bug.
4. Inspect `git diff --check` and the final diff.
5. For runtime-only API behavior that cannot be exercised without the user's key, clearly separate verified code/build behavior from the unverified live provider call.

## Hand off

Summarize the root cause, files changed, checks run, and any remaining live-provider verification. Commit, push, open a PR, deploy, or alter GitHub issues only when the user asks for that external action. If `.openai/hosting.json` exists, follow the Sites workflow for preview or deployment work.
