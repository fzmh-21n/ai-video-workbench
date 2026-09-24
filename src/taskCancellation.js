export const MANUAL_CANCELLATION_ERROR = "已由用户手动取消工作台跟踪；中转后台任务可能仍会继续生成";

export function isTaskCancellable(task) {
  return ["queued", "processing"].includes(task?.status);
}

export function manuallyCancelledTask(task, cancelledAtMs = Date.now()) {
  if (!isTaskCancellable(task)) return task;
  return {
    ...task,
    status: "failed",
    progress: 100,
    error: MANUAL_CANCELLATION_ERROR,
    networkWarning: "",
    nextPollAt: null,
    cancelledAtMs,
    cancelledByUser: true,
  };
}
