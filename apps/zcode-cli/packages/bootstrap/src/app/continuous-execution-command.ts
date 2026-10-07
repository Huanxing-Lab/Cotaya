// ============================================================
// Continuous managed cycle：wire 命令 → 执行端口的分派器（CT-03）
// ============================================================
// v4 命令 `continuousManagedCycle`（载荷/结果 schema 在 @zcode/shared continuous-protocol）
// 到 {@link ContinuousExecutionPort} 的映射。独立成文件而不是塞进 create-app.ts 或适配器：
//   - create-app.ts 已超 max-lines 基线，只做装配（一行 spread）；
//   - 适配器保持「端口实现」单一职责，命令分派是协议层的接线。
//
// 拒绝的走向：适配器抛 {@link ContinuousExecutionError} → 本分派器折叠成结构化
// `{ ok: false, reason, message }` → handler（interaction-background.ts）铸成
// `fault.command.continuousManagedCycleRejected.<reason>`。reason 词表同一份，全程零翻译。

import type {
  ContinuousExecutionPort,
  ExecutionReference,
} from "./continuous-execution-adapter.js";
import { ContinuousExecutionError } from "./continuous-execution-adapter.js";
import type {
  ContinuousManagedCycleCommand,
  ContinuousManagedCycleResult,
} from "@zcode/shared/continuous-protocol";

/** 分派结果：拒绝走 reason（handler 铸 fault），成功携带按 op 的 result。 */
export type ContinuousManagedCycleDispatch =
  | { ok: true; result: ContinuousManagedCycleResult }
  | { ok: false; reason: string; message: string };

/** 命令里的引用四元组 → 端口的引用四元组（同一形状，显式字段搬运而非整包透传）。 */
function referenceOf(command: ContinuousManagedCycleCommand): ExecutionReference {
  return {
    cycleId: command.cycleId,
    executionSessionId: command.executionSessionId,
    workflowRunId: command.workflowRunId,
    traceId: command.traceId,
  };
}

/**
 * 分派一条 managed cycle 执行命令。schema 已保证 op 专属字段的在场（epoch/reason/input），
 * 这里的 `!` 断言因此是「schema 已验」的搬运，不是运行时赌注。
 */
export async function dispatchContinuousManagedCycleCommand(
  port: ContinuousExecutionPort,
  command: ContinuousManagedCycleCommand,
): Promise<ContinuousManagedCycleDispatch> {
  try {
    const ref = referenceOf(command);
    switch (command.op) {
      case "submitOnce": {
        const input = command.input!;
        const reference = await port.submitOnce({
          programId: input.programId,
          cycleId: input.cycleId,
          executionSessionId: input.executionSessionId,
          workflowRunId: input.workflowRunId,
          traceId: input.traceId,
          executionPath: input.executionPath,
          scriptText: input.scriptText,
          scriptHash: input.scriptHash,
          configurationSnapshot: input.configurationSnapshot,
          ...(input.args === undefined ? {} : { args: input.args }),
        });
        return {
          ok: true,
          result: { type: "continuousManagedCycle", op: "submitOnce", reference },
        };
      }
      case "inspect": {
        const state = await port.inspect(ref);
        return { ok: true, result: { type: "continuousManagedCycle", op: "inspect", state } };
      }
      case "resume":
        await port.resume(ref, command.epoch!);
        return { ok: true, result: { type: "continuousManagedCycle", op: "resume" } };
      case "stop":
        await port.stop(ref, command.reason!);
        return { ok: true, result: { type: "continuousManagedCycle", op: "stop" } };
      case "interrupt":
        await port.interrupt(ref, command.epoch!);
        return { ok: true, result: { type: "continuousManagedCycle", op: "interrupt" } };
      case "waitForQuiescence":
        await port.waitForQuiescence(ref);
        return { ok: true, result: { type: "continuousManagedCycle", op: "waitForQuiescence" } };
      case "readReports": {
        const batch = await port.readReports(ref, command.afterSequence ?? 0);
        return {
          ok: true,
          result: { type: "continuousManagedCycle", op: "readReports", batch },
        };
      }
      case "suspendAtSafeBoundary":
        await port.suspendAtSafeBoundary(ref, command.reason!);
        return {
          ok: true,
          result: { type: "continuousManagedCycle", op: "suspendAtSafeBoundary" },
        };
      case "resumeSuspended":
        await port.resumeSuspended(ref, command.epoch!);
        return { ok: true, result: { type: "continuousManagedCycle", op: "resumeSuspended" } };
      case "inspectHealth": {
        const health = await port.inspectHealth(ref);
        return {
          ok: true,
          result: { type: "continuousManagedCycle", op: "inspectHealth", health },
        };
      }
    }
  } catch (error) {
    if (error instanceof ContinuousExecutionError) {
      return { ok: false, reason: error.reason, message: error.message };
    }
    // 非结构化异常原样上抛：接线故障不该被折叠成业务拒绝（run service 关闭后的 launch 等，
    // 与三条既有入口的 assertOpen 同一条纪律）。
    throw error;
  }
}
