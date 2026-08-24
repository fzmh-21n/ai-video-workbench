export function reviewedTask(task, dissatisfied, now = Date.now()) {
  if (dissatisfied) {
    return { ...task, reviewStatus: "dissatisfied", reviewedAtMs: now };
  }
  const { reviewStatus: _reviewStatus, reviewedAtMs: _reviewedAtMs, ...rest } = task;
  return rest;
}

export function regeneratedTaskRecord({
  sourceTask,
  createdTask,
  profile,
  model,
  prompt,
  reuseSnapshot,
  diagnosticRequestId,
  createdAtMs,
  nextPollAt,
  index = 0,
}) {
  const retryAttempt = Number(sourceTask.retryAttempt || 0) + 1;
  const record = {
    ...createdTask,
    profileId: profile.id,
    providerName: profile.name,
    model,
    title: `${sourceTask.title || "视频任务"}-重生成${retryAttempt}`,
    prompt,
    reuseSnapshot,
    projectName: sourceTask.projectName || "",
    retryOfTaskId: sourceTask.id,
    retryAttempt,
    diagnosticRequestId,
    createdAtMs,
    nextPollAt,
  };

  if (sourceTask.batchId) {
    const sourceOrder = Number(sourceTask.batchOrder ?? sourceTask.batchSection ?? 0);
    Object.assign(record, {
      batchId: sourceTask.batchId,
      batchTitle: sourceTask.batchTitle,
      batchSection: sourceTask.batchSection,
      batchOrder: sourceOrder + retryAttempt / 1000 + index / 10000,
    });
  }

  return record;
}
