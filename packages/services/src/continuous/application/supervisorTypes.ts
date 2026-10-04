// Continuous supervisor 家族的共享类型（CT-07 拆分）：放本文件避免
// supervisorLifecycle ↔ supervisorSettlement/Watch/Control 的循环 import
// （架构检查把 type-only import 也计入依赖边）。纯类型，无运行时代码。

import type {
  ContinuousReportCandidateResultItem,
  ContinuousReportCycleResultItem,
} from "@zcode/shared";
import type { Cycle, CycleResult, Program } from "../domain/types.js";

/** 监督一轮的终局结论（supervisor 的 completion 以它 resolve）。 */
export interface SupervisedCycleOutcome {
  cycleId: string;
  cycleStatus: Cycle["status"];
  programStatus: Program["status"];
  result?: CycleResult;
  /** 导入侧拒绝的报告条数（malformed/未过 done 门；细节在拒绝事件里）。 */
  reportRejections: number;
}

/** 启动/恢复一轮的返回（supervisor 与控制面共用）。 */
export interface RunNowResult {
  cycle: Cycle;
  /** 结算完成时 resolve；Host 挂 catch 记日志，不留给 unhandled rejection。 */
  completion: Promise<SupervisedCycleOutcome>;
}

/** 跨批次累计导入结论（监督循环与 settling 共用）。 */
export interface ReportAccumulator {
  candidateResults: Map<
    string,
    { item: ContinuousReportCandidateResultItem; doneAccepted: boolean }
  >;
  cycleResult?: ContinuousReportCycleResultItem;
  itemKeyOfCandidateId: Map<string, string>;
  rejections: number;
}
