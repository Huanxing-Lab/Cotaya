// Continuous（长期自主改进）wire 协议契约：capability、命令参数、快照与结构化错误。
// 唯一产品规则来源：docs/specs/continuous.md（§6/§8/§11）；本文件只做传输校验，不含业务实现。
// service 语义契约在 packages/services/src/continuous/contract.ts；两者共享同一套状态词表，
// 这里是词表唯一来源，services 侧只做类型推导，避免 schema 与领域模型漂移。

import { z } from "zod";
// 身份规则复用既有构造器：workspaceKey === workspaceIdentity?.trim() || workspacePath。
// 不在本文件重新实现 fallback，也不手写格式（AGENTS.md Workspace Identity）。
import { resolveWorkspaceKey } from "./task-realtime-core.js";

const nonEmptyString = z.string().min(1);
const idString = z.string().min(1);
const epochSchema = z.number().int().nonnegative();

// ── capability（独立于普通 Workflow / 权限 mode 枚举）──
// managed cycle capability 是独立能力位：旧 Host/CLI 不携带或回答不支持时，
// 调用方必须拒绝启动（结构化 capability_missing），不能退回普通 prompt 自主执行，
// 也不能被既有 capability（nativeDialogs/workflowRunDeltas 等）误触发。
export const CONTINUOUS_MANAGED_CYCLE_CAPABILITY = "continuousManagedCycles";

export const continuousCapabilityResultSchema = z
  .strictObject({
    supported: z.boolean(),
    capability: z.literal(CONTINUOUS_MANAGED_CYCLE_CAPABILITY),
    /** 协议小版本；向后兼容的 additive 扩展才允许递增。 */
    version: z.number().int().nonnegative(),
  })
  .superRefine((result, ctx) => {
    if (!result.supported && result.version > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "unsupported capability must not advertise a protocol version",
      });
    }
  });
export type ContinuousCapabilityResult = z.infer<typeof continuousCapabilityResultSchema>;

/** 判定 must 用 === true / 字面量等值；旧 capability 形状一律返回 false。 */
export function supportsManagedCycles(capability: unknown): boolean {
  if (typeof capability !== "object" || capability === null) return false;
  const parsed = continuousCapabilityResultSchema.safeParse(capability);
  return parsed.success && parsed.data.supported === true;
}

// ── 状态词表（规格 §5；services domain 与 SQL CHECK 同集）──
export const continuousProgramStatusSchema = z.enum([
  "active",
  "sleeping",
  "paused",
  "failed",
  "completed",
]);
export type ContinuousProgramStatus = z.infer<typeof continuousProgramStatusSchema>;

export const continuousCycleStatusSchema = z.enum([
  "preparing",
  "running",
  "settling",
  "interrupted",
  "suspended",
  "completed",
  "failed",
  "cancelled",
]);
export type ContinuousCycleStatus = z.infer<typeof continuousCycleStatusSchema>;

/** 未结束 Cycle（含 suspended）；同一 Program 最多一个（continuous_one_open_cycle 索引）。 */
export const CONTINUOUS_OPEN_CYCLE_STATUSES = [
  "preparing",
  "running",
  "settling",
  "interrupted",
  "suspended",
] as const satisfies readonly ContinuousCycleStatus[];

export const continuousCandidateStatusSchema = z.enum([
  "candidate",
  "queued",
  "implementing",
  "done",
  "rejected",
  "deferred",
]);
export type ContinuousCandidateStatus = z.infer<typeof continuousCandidateStatusSchema>;

export const continuousDecisionStatusSchema = z.enum(["pending", "resolved", "dismissed"]);
export type ContinuousDecisionStatus = z.infer<typeof continuousDecisionStatusSchema>;

export const continuousCycleHealthStateSchema = z.enum([
  "progressing",
  "normal_wait",
  "suspected_hang",
  "unreachable",
]);
export type ContinuousCycleHealthState = z.infer<typeof continuousCycleHealthStateSchema>;

// ── 配置策略（授权时快照；金额一律整数微美元，不用浮点累加）──
export const continuousScopePolicySchema = z.strictObject({
  /** 允许修改的路径前缀（授权路径外写入返回 scope_denied）。 */
  allowedPaths: z.array(nonEmptyString),
  forbiddenPaths: z.array(nonEmptyString),
  /** 规格默认禁止的能力面；不能通过“继续”确认绕过（§6.1）。 */
  forbiddenCapabilities: z.array(
    z.enum(["backend_rewrite", "db_migration", "billing_auth", "deploy", "push", "merge"]),
  ),
});
export type ContinuousScopePolicy = z.infer<typeof continuousScopePolicySchema>;

export const continuousBudgetPolicySchema = z.strictObject({
  /** null = Unlimited（只取消每日额度；单轮限制仍生效）。 */
  dailyCostUsdMicros: z.number().int().positive().nullable(),
  perCycleCostUsdMicros: z.number().int().positive(),
  perCycleTokens: z.number().int().positive(),
  perCycleMaxImprovements: z.number().int().positive(),
  perCycleMaxFiles: z.number().int().positive(),
  perCycleMaxChangedLines: z.number().int().positive(),
  maxConcurrentActors: z.number().int().positive(),
  activeExecutionLimitMs: z.number().int().positive(),
  maxModelRequestAttempts: z.number().int().positive(),
  maxResumeAttempts: z.number().int().positive(),
});
export type ContinuousBudgetPolicy = z.infer<typeof continuousBudgetPolicySchema>;

/** 产品默认值（规格 §2 设置表）；金额为微美元整数。 */
export const CONTINUOUS_DEFAULT_BUDGET: ContinuousBudgetPolicy = {
  dailyCostUsdMicros: 1_000_000_000, // USD 1,000/日；Unlimited 需显式选择
  perCycleCostUsdMicros: 100_000_000, // USD 100/单轮，必须为正的有限值
  perCycleTokens: 1_000_000_000,
  perCycleMaxImprovements: 3,
  perCycleMaxFiles: 10,
  perCycleMaxChangedLines: 400,
  maxConcurrentActors: 10, // builder 仍最多 1 个，由执行策略保证
  activeExecutionLimitMs: 3_600_000, // 有效执行 1 小时；正常阻塞不计时
  maxModelRequestAttempts: 3,
  maxResumeAttempts: 2,
};

export const continuousCadencePolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("interval"), hoursAfterCycleEnd: z.number().positive() }),
  z.strictObject({
    kind: z.literal("daily"),
    /** 本地 HH:mm；按 Program 持久化时区求下一次未来时点。 */
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: nonEmptyString,
  }),
]);
export type ContinuousCadencePolicy = z.infer<typeof continuousCadencePolicySchema>;

export const CONTINUOUS_DEFAULT_CADENCE: ContinuousCadencePolicy = {
  kind: "interval",
  hoursAfterCycleEnd: 6,
};

/** 决策策略：未知语义类别默认进入 Decision（§8），第一版不接受关闭该行为。 */
export const continuousDecisionPolicySchema = z.strictObject({
  unknownToDecision: z.literal(true),
});
export type ContinuousDecisionPolicy = z.infer<typeof continuousDecisionPolicySchema>;

export const continuousTemplateRefSchema = z.strictObject({
  templateId: idString,
  templateVersion: nonEmptyString,
  /** 模板脚本内容 hash（sha256 hex）；授权与 resume 都用它防脚本漂移。 */
  templateHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ContinuousTemplateRef = z.infer<typeof continuousTemplateRefSchema>;

// ── 命令身份（规格 §4：workspaceIdentity?.trim() || workspacePath，远程贯穿 remoteSessionId）──
export const continuousCommandContextSchema = z
  .strictObject({
    workspacePath: nonEmptyString,
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
    workspaceKey: nonEmptyString,
    traceId: nonEmptyString,
  })
  .superRefine((context, ctx) => {
    if (context.workspaceKey !== resolveWorkspaceKey(context)) {
      ctx.addIssue({
        code: "custom",
        path: ["workspaceKey"],
        message: "workspaceKey must match workspaceIdentity fallback rule",
      });
    }
  });
export type ContinuousCommandContext = z.infer<typeof continuousCommandContextSchema>;

// ── 方法与命令参数（全部 strict：新增字段是协议变更，不允许静默透传）──
export const CONTINUOUS_METHODS = {
  capabilityQuery: "continuous/capability",
  snapshot: "continuous/snapshot",
  createProgram: "continuous/createProgram",
  runNow: "continuous/runNow",
  pauseProgram: "continuous/pauseProgram",
  resumeProgram: "continuous/resumeProgram",
  stopCurrentCycle: "continuous/stopCurrentCycle",
  resolveDecision: "continuous/resolveDecision",
  dismissDecision: "continuous/dismissDecision",
  archiveProgram: "continuous/archiveProgram",
} as const;
export type ContinuousMethod = (typeof CONTINUOUS_METHODS)[keyof typeof CONTINUOUS_METHODS];

const commandBase = {
  context: continuousCommandContextSchema,
  programId: idString,
} as const;

export const continuousSnapshotParamsSchema = z.strictObject({
  context: continuousCommandContextSchema,
});
export type ContinuousSnapshotParams = z.infer<typeof continuousSnapshotParamsSchema>;

export const continuousCreateProgramParamsSchema = z.strictObject({
  context: continuousCommandContextSchema,
  goal: nonEmptyString,
  scope: continuousScopePolicySchema,
  budget: continuousBudgetPolicySchema,
  cadence: continuousCadencePolicySchema,
  decisionPolicy: continuousDecisionPolicySchema,
  template: continuousTemplateRefSchema,
});
export type ContinuousCreateProgramParams = z.infer<typeof continuousCreateProgramParamsSchema>;

/** manual trigger 用请求 ID 做幂等（规格 §10）；重复 Run now 不得创建第二个 Cycle。 */
export const continuousRunNowParamsSchema = z.strictObject({
  ...commandBase,
  requestId: idString,
});
export type ContinuousRunNowParams = z.infer<typeof continuousRunNowParamsSchema>;

/**
 * Pause 只表达“本轮结束后暂停”（§6）；刻意不提供 immediate/force 字段——
 * 立即停止本轮是独立命令 stopCurrentCycle，两者语义与撤销顺序不同，不能互相冒充。
 */
export const continuousPauseProgramParamsSchema = z.strictObject({ ...commandBase });
export type ContinuousPauseProgramParams = z.infer<typeof continuousPauseProgramParamsSchema>;

export const continuousResumeProgramParamsSchema = z.strictObject({ ...commandBase });
export type ContinuousResumeProgramParams = z.infer<typeof continuousResumeProgramParamsSchema>;

export const continuousStopReasonSchema = z.enum(["user_request", "config_change", "shutdown"]);

/** 立即停止本轮：撤销写入/请求许可 → 取消 → 等待停止；必须携带 cycleId 与当前 lease epoch。 */
export const continuousStopCurrentCycleParamsSchema = z.strictObject({
  ...commandBase,
  cycleId: idString,
  epoch: epochSchema,
  reason: continuousStopReasonSchema,
});
export type ContinuousStopCurrentCycleParams = z.infer<
  typeof continuousStopCurrentCycleParamsSchema
>;

/** Resolve 使用 version 防止覆盖其他回答（§8）；optionId 与 text 至少一项。 */
export const continuousResolveDecisionParamsSchema = z
  .strictObject({
    ...commandBase,
    decisionId: idString,
    version: z.number().int().positive(),
    optionId: idString.optional(),
    text: nonEmptyString.optional(),
  })
  .superRefine((params, ctx) => {
    if (params.optionId === undefined && params.text === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["optionId"],
        message: "resolve requires optionId or text",
      });
    }
  });
export type ContinuousResolveDecisionParams = z.infer<typeof continuousResolveDecisionParamsSchema>;

/** Dismiss 不授权实施，也不自动扩大 forbidden 范围（§8）。 */
export const continuousDismissDecisionParamsSchema = z.strictObject({
  ...commandBase,
  decisionId: idString,
  version: z.number().int().positive(),
});
export type ContinuousDismissDecisionParams = z.infer<typeof continuousDismissDecisionParamsSchema>;

/** 归档前必须没有主动执行（§5）；不级联清除审计历史。 */
export const continuousArchiveProgramParamsSchema = z.strictObject({ ...commandBase });
export type ContinuousArchiveProgramParams = z.infer<typeof continuousArchiveProgramParamsSchema>;

// ── 快照结果（UI 唯一事实来源；局部草稿与 optimistic overlay 不是业务事实）──
export const continuousProgramSummarySchema = z.strictObject({
  programId: idString,
  workspaceKey: nonEmptyString,
  workspacePath: nonEmptyString,
  workspaceIdentity: z.string().optional(),
  remoteSessionId: z.string().optional(),
  revision: z.number().int().positive(),
  goal: z.string(),
  status: continuousProgramStatusSchema,
  statusReason: z.string().optional(),
  nextCycleAt: z.number().int().nonnegative().nullable(),
  currentCycleId: idString.nullable(),
  pendingDecisionCount: z.number().int().nonnegative(),
  pendingContinuationRequestId: idString.nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type ContinuousProgramSummary = z.infer<typeof continuousProgramSummarySchema>;

export const continuousSnapshotResultSchema = z.strictObject({
  programs: z.array(continuousProgramSummarySchema),
  at: z.number().int().nonnegative(),
});
export type ContinuousSnapshotResult = z.infer<typeof continuousSnapshotResultSchema>;

// ── 结构化错误（规格 §11“至少包括”清单 + capability_missing；结构必须稳定）──
export const CONTINUOUS_ERROR_CODES = [
  "capability_missing",
  "authorization_stale",
  "scope_denied",
  "budget_denied",
  "usage_unknown",
  "lease_lost",
  "execution_not_quiescent",
  "execution_identity_mismatch",
  "template_mismatch",
  "remote_execution_not_supported",
  "validation_unavailable",
] as const;
export type ContinuousErrorCode = (typeof CONTINUOUS_ERROR_CODES)[number];

export const continuousErrorSchema = z.strictObject({
  code: z.enum(CONTINUOUS_ERROR_CODES),
  message: z.string().min(1).max(2048),
  /** 幂等重试是否安全；不携带堆栈、凭据或内部服务地址。 */
  retryable: z.boolean(),
});
export type ContinuousError = z.infer<typeof continuousErrorSchema>;

export function isContinuousError(value: unknown): value is ContinuousError {
  return continuousErrorSchema.safeParse(value).success;
}

// ── managed cycle 执行面（CT-03）──
// wire 契约搬到 continuous-execution-protocol.ts（本文件到 max-lines 上限；拆分是行数约束的
// 结果，不是边界变化——见那边文件头）。这里原样再导出，公开路径保持 continuous-protocol 一个，
// 既有 importer（services contract、zcode-protocol index）不必改。
export * from "./continuous-execution-protocol.js";

// ── 预算协议（CT-04）──
// 价格快照 schema 与微美元估算数学放 continuous-budget-protocol.ts（CLI 闸门与 Host 账本
// 共用同一实现；见那边文件头）。同样从这里再导出，公开路径不变。
export * from "./continuous-budget-protocol.js";

// ── 报告协议（CT-05）──
// 版本化 ContinuousReportV1 的载荷 schema 放 continuous-report-protocol.ts（模板产出侧与
// 导入校验侧共用同一份词汇表；见那边文件头）。同样从这里再导出，公开路径不变。
export * from "./continuous-report-protocol.js";
