import { recordedTaskResolution } from "./taskResolution.js";

const FIELDS = [
  "id", "upstreamTaskId", "profileId", "providerName", "model", "projectName",
  "batchId", "batchTitle", "batchSection", "createdAtMs", "updatedAtMs", "createdAt", "completedAt",
  "status", "error", "retryOfTaskId", "retryAttempt", "cancelledByUser", "cost", "archivedAtMs", "submissionVerified",
];

export function submissionRecord(task) {
  const record = Object.fromEntries(FIELDS
    .filter((field) => task?.[field] !== undefined && (field === "submissionVerified"
      ? typeof task[field] === "boolean"
      : task[field] === null || ["string", "number", "boolean"].includes(typeof task[field])))
    .map((field) => [field, field === "error" ? String(task[field] || "").slice(0, 500) : task[field]]));
  const resolution = recordedTaskResolution(task);
  if (resolution) record.resolution = resolution;
  return record;
}

function createdTime(record) {
  const direct = Number(record?.createdAtMs);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(String(record?.createdAt || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function mergeSubmissionRecord(stored, update) {
  const record = submissionRecord(update);
  if (!record.id || stored?.id !== record.id) return record;
  // Receipt pricing attributes are immutable once known; polling/metadata updates must not erase them.
  if (recordedTaskResolution(stored)) record.resolution = recordedTaskResolution(stored);
  const previous = createdTime(stored);
  const incoming = createdTime(record);
  if (previous && (!incoming || previous <= incoming)) {
    record.createdAtMs = previous;
    if (stored.createdAt !== undefined) record.createdAt = stored.createdAt;
    else delete record.createdAt;
  }
  if (stored.submissionVerified === true) record.submissionVerified = true;
  else if (record.submissionVerified === undefined && stored.submissionVerified === false) record.submissionVerified = false;
  else if (record.submissionVerified === false && stored.submissionVerified !== false) delete record.submissionVerified;
  return record;
}
