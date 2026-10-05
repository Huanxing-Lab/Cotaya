// 等待队列不保存另一份准入状态；每次都读取执行适配器的唯一状态。
export function createContinuousAdmissionWaiters(
  stateOf: (cycleId: string) => "open" | "suspended" | "revoked",
) {
  const queues = new Map<string, Set<() => void>>();
  return {
    async wait(cycleId: string, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      if (stateOf(cycleId) === "open") return;
      await new Promise<void>((resolve, reject) => {
        const queue = queues.get(cycleId) ?? new Set<() => void>();
        queues.set(cycleId, queue);
        const clean = () => {
          queue.delete(check);
          if (queue.size === 0) queues.delete(cycleId);
          signal?.removeEventListener("abort", abort);
        };
        const abort = () => {
          clean();
          reject(signal?.reason ?? new Error("continuous wait aborted"));
        };
        const check = () => {
          const state = stateOf(cycleId);
          if (state === "suspended") return;
          clean();
          if (state === "revoked") reject(new Error("continuous admission revoked"));
          else resolve();
        };
        queue.add(check);
        signal?.addEventListener("abort", abort, { once: true });
        check();
      });
    },
    notify(cycleId: string): void {
      for (const check of queues.get(cycleId) ?? []) check();
    },
  };
}
