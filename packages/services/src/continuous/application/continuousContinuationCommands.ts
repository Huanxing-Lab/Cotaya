// Continuous 继续确认命令（CT-08）：resolveContinuation 的实现体。
// 从 continuousCommandService.ts 拆出（oxlint max-lines 400），不是边界变化——
// 命令门面仍是对外唯一入口，本文件只承载 §6.1 四选项的回答链：
//   resolve（扩额唯一写入者，version 防重复/E-32）→
//     continue_with_grant        —— 同 Cycle/Run 恢复（supervisor.continueSuspendedCycle）；
//     adjust_config_and_continue —— 先保存新长期预算/时长（不递增授权 revision、不扩大
//                                   Scope，§6「单纯预算修改」）再同 Cycle 恢复；
//     stay_paused                —— 保留 pending 工作，不动执行；
//     end_cycle                  —— 明确用户取消后才结算：走立即停止链（撤销→取消→等待
//                                   停止→cancelled+paused），保留已验证提交（§6/§6.1）。

import type {
  ContinuousResolveContinuationParams,
  ContinuousResolveContinuationResult,
} from "@zcode/shared";
import type { ContinuousRepositoryPort } from "./ports.js";
import type { ContinuousService } from "./continuousService.js";
import type { ContinuousSupervisor } from "./supervisor.js";
import type { ContinuousContinuationService } from "./continuationService.js";
import { commandError, requireProgramOf } from "./continuousCommandErrors.js";

export interface ContinuationCommandDeps {
  repository: ContinuousRepositoryPort;
  supervisor: ContinuousSupervisor;
  store: ContinuousService;
  continuations: ContinuousContinuationService;
  clock: { now(): number };
}

/** continue 类回答后的同 Cycle/Run 恢复；对「resolve 已落库但 resume 曾失败」的重放同样适用
 * （resolve 幂等 no-op，这里再试一次恢复——扩额不会重复，因为 resolve 才写 grant）。 */
async function resumeForContinuation(
  deps: ContinuationCommandDeps,
  cycleId: string,
): Promise<string> {
  const result = await deps.supervisor.continueSuspendedCycle(cycleId);
  return result.cycle.id;
}

export async function resolveContinuationCommand(
  deps: ContinuationCommandDeps,
  params: ContinuousResolveContinuationParams,
): Promise<ContinuousResolveContinuationResult> {
  const program = await requireProgramOf(deps.repository, params);
  const request = await deps.repository.getContinuationRequest(params.requestId);
  if (!request || request.programId !== program.id) {
    throw commandError(
      "capability_missing",
      `继续确认请求不存在或不属于 program ${params.programId}: ${params.requestId}`,
    );
  }
  // resolve 是扩额的唯一写入者（同 version 同答案重放幂等、旧 version 拒绝，E-32）。
  const resolved = await deps.continuations.resolve({
    requestId: params.requestId,
    version: params.version,
    answer: toContinuationAnswer(params),
  });
  let resumedCycleId: string | null = null;
  const answer = params.answer;
  if (answer.kind === "continue_with_grant") {
    resumedCycleId = await resumeForContinuation(deps, request.cycleId);
  } else if (answer.kind === "adjust_config_and_continue") {
    // §6.1 选项 2：保存新长期配置 + 本轮 grant；降低预算立即影响新请求。
    await deps.store.saveProgram({
      ...program,
      budget: {
        ...program.budget,
        ...(answer.configAdjustment.perCycleCostUsdMicros === undefined
          ? {}
          : { perCycleCostUsdMicros: answer.configAdjustment.perCycleCostUsdMicros }),
        ...(answer.configAdjustment.dailyCostUsdMicros === undefined
          ? {}
          : { dailyCostUsdMicros: answer.configAdjustment.dailyCostUsdMicros }),
        ...(answer.configAdjustment.perCycleTokens === undefined
          ? {}
          : { perCycleTokens: answer.configAdjustment.perCycleTokens }),
        ...(answer.configAdjustment.activeExecutionLimitMs === undefined
          ? {}
          : { activeExecutionLimitMs: answer.configAdjustment.activeExecutionLimitMs }),
      },
      updatedAt: deps.clock.now(),
    });
    resumedCycleId = await resumeForContinuation(deps, request.cycleId);
  } else if (answer.kind === "end_cycle") {
    // §6.1 选项 4：明确用户取消后才结算 cancelled/partial；保留已验证提交。
    // epoch 取当前占用——suspended 保留占用（§6.1），行就是权威值。
    const lease = await deps.repository.getLease(program.workspaceKey);
    const open = await deps.repository.getOpenCycle(program.id);
    if (open && open.id === request.cycleId) {
      await deps.supervisor.stopCurrentCycle({
        programId: program.id,
        epoch: lease?.epoch ?? open.leaseEpoch,
      });
    }
  }
  return {
    requestId: resolved.id,
    status: resolved.status,
    version: resolved.version,
    resolutionKind: answer.kind,
    resumedCycleId,
  };
}

function toContinuationAnswer(
  params: ContinuousResolveContinuationParams,
): Parameters<ContinuousContinuationService["resolve"]>[0]["answer"] {
  const answer = params.answer;
  if (answer.kind === "continue_with_grant") {
    return { kind: "continue_with_grant", grant: answer.grant };
  }
  if (answer.kind === "adjust_config_and_continue") {
    return {
      kind: "adjust_config_and_continue",
      grant: answer.grant,
      configAdjustment: answer.configAdjustment,
    };
  }
  if (answer.kind === "stay_paused") return { kind: "stay_paused" };
  return { kind: "end_cycle" };
}
