import type { ContinuousExecutionRejectionReason } from "@zcode/shared/continuous-protocol";
import type { ManagedRunSubmitRejection } from "./dynamic-workflow-run-managed-submit.js";
import type { ContinuousReportItem, ExecutionState } from "./continuous-execution-contract.js";

/** submitOnce 拒绝 → 适配器拒绝：身份三元组归一为 execution_identity_mismatch（规格 §11）。 */
export function submitRejectionOf(
  reason: ManagedRunSubmitRejection,
): ContinuousExecutionRejectionReason {
  switch (reason) {
    case "owner_mismatch":
    case "script_mismatch":
    case "args_mismatch":
      return "execution_identity_mismatch";
    case "completed":
    case "errored":
      return "not_resumable";
    case "superseded":
      return "superseded";
    case "stopped":
      return "stopped";
  }
}

/** ContinuousReportV1 的五个 item 种类（读侧投影的合法词表）。 */
const REPORT_ITEM_KINDS: ReadonlySet<string> = new Set([
  "candidate",
  "decision",
  "validation",
  "candidate_result",
  "cycle_result",
]);

/** journal report 行 → ContinuousReportItem：kind/itemKey 从载荷投影，投不出来就诚实标 unknown。 */
export function toReportItem(
  runId: string,
  row: { sequence: number; item: unknown },
): ContinuousReportItem {
  const payload = row.item;
  const candidate = payload as { kind?: unknown; itemKey?: unknown } | null;
  const shaped = typeof candidate === "object" && candidate !== null;
  const kind =
    shaped && typeof candidate.kind === "string" && REPORT_ITEM_KINDS.has(candidate.kind)
      ? (candidate.kind as ContinuousReportItem["kind"])
      : "unknown";
  const itemKey =
    shaped && typeof candidate.itemKey === "string" && candidate.itemKey.length > 0
      ? candidate.itemKey
      : // 回退键由 journal sequence 派生（规格 §11「itemKey 加来源 journal sequence 去重」）：
        // 载荷没有自带 itemKey 时，sequence 本身就是这条报告的稳定去重身份。
        `report:${runId}:${row.sequence}`;
  return { kind, itemKey, journalSequence: row.sequence, payload };
}

/** ExecutionState.status 的运行态判定（live 注册表条目优先于 journal 行）。 */
export function executionStatusOf(
  live: boolean,
  status: "pending" | "running" | "completed" | "errored" | "stopped",
): ExecutionState["status"] {
  if (live && (status === "pending" || status === "running")) return "running";
  return status;
}
