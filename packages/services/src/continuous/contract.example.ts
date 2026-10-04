// contract 使用示例（受控上下文的一部分，不参与生产装配）：
// 展示 capability 查询的强制顺序——未支持时必须失败，不能退回普通 prompt 自主执行。
import type { ContinuousRunNowParams, ContinuousSnapshotResult } from "@zcode/shared";
import { supportsManagedCycles } from "@zcode/shared";
import type { IContinuousService } from "./contract.js";

export async function runCycleNowSafely(
  service: IContinuousService,
  params: ContinuousRunNowParams,
): Promise<ContinuousSnapshotResult> {
  if (!supportsManagedCycles(service.capability())) {
    // 旧 CLI/旧 Host：结构化拒绝（capability_missing），绝不静默降级为普通 Workflow。
    throw new Error("continuous managed cycles not supported by this host");
  }
  await service.runNow(params);
  // CT-08 起 snapshot 参数形与 wire schema 对齐（{context}）。
  return service.snapshot({ context: params.context });
}
