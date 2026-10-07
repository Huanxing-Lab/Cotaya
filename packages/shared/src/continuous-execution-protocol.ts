// Continuous managed cycle 执行面（CT-03）：CLI bootstrap 适配器经 v4 命令暴露的受控执行端口
// 的 wire 契约——规格 §11 ContinuousExecutionPort 的传输形态。
//
// 为什么独立成文件而不是并入 continuous-protocol.ts：那一份（capability/业务命令/快照/错误）
// 已到仓库 lint 的 max-lines 上限，执行面是另一组消费者（v4 命令层 + bootstrap 适配器）；
// continuous-protocol.ts 以 `export *` 再导出本文件，公开路径保持一个（package.json 不新增
// entry），既有 importer 不改。两个文件都不含业务实现，只做传输校验。

import { z } from "zod";

// 与 continuous-protocol.ts 同款的三件小工具（本文件刻意不反向 import 它，避免两文件互相
// 引用；重复三行优于一个循环依赖——zod schema 常量在模块初始化期求值）。
const nonEmptyString = z.string().min(1);
const idString = z.string().min(1);
const epochSchema = z.number().int().nonnegative();

/** 受控执行的拒绝词表：前七个与 DWF resume 门同名同义，后四个是适配器守卫（§6/§10/§11）。 */
export const continuousExecutionRejectionReasonSchema = z.enum([
  "not_found",
  "not_resumable",
  "superseded",
  "already_running",
  "script_missing",
  "script_mismatch",
  "compile_failed",
  "execution_identity_mismatch",
  "lease_lost",
  "stopped",
  "not_suspended",
]);
export type ContinuousExecutionRejectionReason = z.infer<
  typeof continuousExecutionRejectionReasonSchema
>;

/** submitOnce 携带的执行身份绑定（规格 §10「执行 ID 在提交前保存」）。 */
export const continuousManagedCycleInputSchema = z.strictObject({
  programId: idString,
  cycleId: idString,
  executionSessionId: idString,
  workflowRunId: idString,
  traceId: idString,
  /** Program worktree：actor 实际工作目录（规格 §11）。 */
  executionPath: nonEmptyString,
  scriptText: nonEmptyString,
  /** scriptText 的 sha256 hex；与文本对不上按 execution_identity_mismatch 拒绝。 */
  scriptHash: z.string().regex(/^[0-9a-f]{64}$/),
  configurationSnapshot: z.unknown(),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type ContinuousManagedCycleInput = z.infer<typeof continuousManagedCycleInputSchema>;

export const continuousManagedCycleOpSchema = z.enum([
  "submitOnce",
  "inspect",
  "resume",
  "stop",
  "interrupt",
  "waitForQuiescence",
  "readReports",
  "suspendAtSafeBoundary",
  "resumeSuspended",
  "inspectHealth",
]);
export type ContinuousManagedCycleOp = z.infer<typeof continuousManagedCycleOpSchema>;

/**
 * v4 命令 `continuousManagedCycle` 的载荷。所有 op 共用一份 strict 载荷：ExecutionReference
 * 四元组必带（身份先于操作），op 专属字段可选、由 superRefine 按 op 校验在场（resume/
 * resumeSuspended 必带 epoch，stop/suspendAtSafeBoundary 必带 reason，submitOnce 必带与命令
 * 身份绑定的 input）。命令面因此只有一张 schema，没有九张。
 */
export const continuousManagedCycleCommandSchema = z
  .strictObject({
    op: continuousManagedCycleOpSchema,
    cycleId: idString,
    executionSessionId: idString,
    workflowRunId: idString,
    traceId: idString,
    epoch: epochSchema.optional(),
    reason: z.string().min(1).max(512).optional(),
    afterSequence: z.number().int().nonnegative().optional(),
    input: continuousManagedCycleInputSchema.optional(),
  })
  .superRefine((command, ctx) => {
    const requireField = (present: boolean, field: string, message: string): void => {
      if (!present) ctx.addIssue({ code: "custom", path: [field], message });
    };
    switch (command.op) {
      case "submitOnce":
        requireField(
          command.input !== undefined &&
            command.input.cycleId === command.cycleId &&
            command.input.workflowRunId === command.workflowRunId,
          "input",
          "submitOnce requires an input bound to the same cycle/run identity",
        );
        break;
      case "resume":
      case "resumeSuspended":
      case "interrupt":
        requireField(command.epoch !== undefined, "epoch", `${command.op} requires epoch`);
        break;
      case "stop":
      case "suspendAtSafeBoundary":
        requireField(command.reason !== undefined, "reason", `${command.op} requires reason`);
        break;
      // inspect / waitForQuiescence / readReports / inspectHealth：引用四元组已足够。
      default:
        break;
    }
  });
export type ContinuousManagedCycleCommand = z.infer<typeof continuousManagedCycleCommandSchema>;

/** 执行引用四元组（结果与命令共用一份形状）。 */
export const continuousExecutionReferenceSchema = z.strictObject({
  cycleId: idString,
  executionSessionId: idString,
  workflowRunId: idString,
  traceId: idString,
});
export type ContinuousExecutionReference = z.infer<typeof continuousExecutionReferenceSchema>;

export const continuousExecutionStateSchema = z.strictObject({
  runId: idString,
  status: z.enum(["pending", "running", "completed", "errored", "stopped"]),
  stopReason: z.string().optional(),
  failureCode: z.string().optional(),
  resumable: z.boolean(),
});
export type ContinuousExecutionState = z.infer<typeof continuousExecutionStateSchema>;

/** 读侧报告条目：kind 比 services 端口多一个 "unknown"（不丢行、不编造类别，见 CT-03 记录）。 */
export const continuousReportItemSchema = z.strictObject({
  kind: z.enum([
    "candidate",
    "decision",
    "validation",
    "candidate_result",
    "cycle_result",
    "unknown",
  ]),
  itemKey: nonEmptyString,
  journalSequence: z.number().int().nonnegative(),
  payload: z.unknown(),
});
export type ContinuousReportItemWire = z.infer<typeof continuousReportItemSchema>;

export const continuousReportBatchSchema = z.strictObject({
  items: z.array(continuousReportItemSchema),
  nextCursor: z.number().int().nonnegative(),
});

export const continuousHealthSnapshotSchema = z.strictObject({
  runId: idString,
  actorIds: z.array(nonEmptyString),
  lastProgressAt: z.number().int().nonnegative().optional(),
  waitingFor: z
    .strictObject({
      ownerId: nonEmptyString,
      reason: nonEmptyString,
      deadlineAt: z.number().int().nonnegative(),
    })
    .optional(),
  ownerEpoch: epochSchema,
  reachable: z.boolean(),
  admissionState: z.enum(["open", "suspended", "revoked"]),
});
export type ContinuousHealthSnapshotWire = z.infer<typeof continuousHealthSnapshotSchema>;

/** `continuousManagedCycle` 命令的 ACK.result（按 op 判别；void 操作只回 op 本身）。 */
export const continuousManagedCycleResultSchema = z.discriminatedUnion("op", [
  z.strictObject({
    type: z.literal("continuousManagedCycle"),
    op: z.literal("submitOnce"),
    reference: continuousExecutionReferenceSchema,
  }),
  z.strictObject({
    type: z.literal("continuousManagedCycle"),
    op: z.literal("inspect"),
    state: continuousExecutionStateSchema,
  }),
  z.strictObject({
    type: z.literal("continuousManagedCycle"),
    op: z.enum([
      "resume",
      "stop",
      "interrupt",
      "waitForQuiescence",
      "suspendAtSafeBoundary",
      "resumeSuspended",
    ]),
  }),
  z.strictObject({
    type: z.literal("continuousManagedCycle"),
    op: z.literal("readReports"),
    batch: continuousReportBatchSchema,
  }),
  z.strictObject({
    type: z.literal("continuousManagedCycle"),
    op: z.literal("inspectHealth"),
    health: continuousHealthSnapshotSchema,
  }),
]);
export type ContinuousManagedCycleResult = z.infer<typeof continuousManagedCycleResultSchema>;

/** 拒绝 fault 前缀（与 workflowRunResumeRejected 同族；bootstrap 拼接、读侧前缀匹配）。 */
export const CONTINUOUS_MANAGED_CYCLE_REJECTED_FAULT_PREFIX =
  "fault.command.continuousManagedCycleRejected." as const;
