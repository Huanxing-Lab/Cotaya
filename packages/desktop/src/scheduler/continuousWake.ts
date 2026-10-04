// Continuous 到期唤醒（CT-07；scheduler 侧只读查询 + 转发，不派发）。
//
// 与 automation 的 claim-派发-释放锁语义刻意不同：本模块不写任何业务表、不保存派发
// 状态——重复 wake 由 Host 侧 trigger key UNIQUE 与「一个 Program 一条未结束 Cycle」约束
// 幂等吸收（docs/specs/continuous.md §10 wake 链路）。进程内只记「已送达的到期窗口」，
// 同一窗口（同一 nextCycleAt）只送一次；送达失败（无 Host/未装配）清除记录，仍到期时
// 下一轮 tick 重发。scheduler 重启即重置，无害（wake 幂等）。

import { ContinuousWakeSource } from "@zcode/services/node";
import type { ContinuousDueProgram } from "@zcode/services/node";
import type { SchedulerToMainMessage } from "./schedulerProtocol.js";

export interface ContinuousWakeDispatcher {
  /** 每 tick 查询到期并投递未送达的 wake。 */
  pollDue(now: number): Promise<void>;
  /** main/host 的送达回执：ok 记录送达（同窗口不重发）；失败清除记录待重发。 */
  handleResult(msg: { programId: string; dueAt: number; ok: boolean; error?: string }): void;
  /** 退出时关闭只读连接。 */
  close(): void;
}

export function createContinuousWakeDispatcher(deps: {
  log: (level: "info" | "warn" | "error", message: string) => void;
  postMessage: (message: SchedulerToMainMessage) => void;
}): ContinuousWakeDispatcher {
  const source = new ContinuousWakeSource();
  const delivered = new Map<string, number>();

  const send = (program: ContinuousDueProgram): void => {
    deps.postMessage({
      type: "continuous-wake-request",
      programId: program.programId,
      dueAt: program.nextCycleAt,
      workspacePath: program.workspacePath,
      ...(program.workspaceIdentity ? { workspaceIdentity: program.workspaceIdentity } : {}),
    });
  };

  return {
    async pollDue(now: number): Promise<void> {
      let due: ContinuousDueProgram[];
      try {
        due = await source.listDue(now);
      } catch (error) {
        // 查询失败只记日志：缺表（旧库未升级）返回空表是功能未启用的正常形态。
        deps.log(
          "warn",
          `continuous due query failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      for (const program of due) {
        if (delivered.get(program.programId) === program.nextCycleAt) continue;
        send(program);
      }
    },
    handleResult(msg): void {
      if (msg.ok) {
        delivered.set(msg.programId, msg.dueAt);
        return;
      }
      delivered.delete(msg.programId);
      deps.log(
        "info",
        `continuous wake undelivered program=${msg.programId}: ${msg.error ?? "unknown"}`,
      );
    },
    close(): void {
      try {
        source.close();
      } catch {
        // 忽略：退出路径尽力而为。
      }
    },
  };
}
