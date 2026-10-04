// Continuous UI wire 契约（CT-08，additive）+ 策略 schema 单一实现的家。
// 唯一产品规则来源：docs/specs/continuous.md（§2 默认值、§5 词表、§6.1 继续确认、
// §11 Integration 接口、§12 UI）。
//
// 拆分原因同 continuous-execution/budget/report-protocol：continuous-protocol.ts 已到
// oxlint max-lines 上限。本文件刻意不反向 import continuous-protocol（避免两文件互相
// 引用的环）；因此配置策略 schema（Scope/Budget/Cadence/Decision/Template）与状态词表
// 从 continuous-protocol **移入本文件**（移动不是复制——continuous-protocol 经
// `export *` 照常再导出，公开路径与既有 importer 均不变）。携带 command context 的
// params schema 留在 continuous-protocol.ts（context schema 住在那边）。
//
// CT-08 新增的三个 additive 命令（协议小版本 0→1）：
//   continuous/templates           —— 创建授权表单的可用模板目录（版本化注册表经 Host 注入）；
//   continuous/programDetail       —— Program 详情页唯一读面（§12 要求的 Status/Goal/Scope/
//                                      Budget/Cadence/Health/继续确认/Cycle/队列/分支交付）；
//   continuous/resolveContinuation —— 资源继续确认的回答（§6.1 四选项；version 防重复扩额）。

import { z } from "zod";

const nonEmptyString = z.string().min(1);
const idString = z.string().min(1);

// ── 状态词表（规格 §5；services domain 与 SQL CHECK 同集）──
// （自 continuous-protocol.ts 移入；见文件头说明。）
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
  forbiddenPaths: z.array(z.string()),
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

// ── templates 结果 ──

export const continuousTemplatesResultSchema = z.strictObject({
  templates: z.array(continuousTemplateRefSchema),
});
export type ContinuousTemplatesResult = z.infer<typeof continuousTemplatesResultSchema>;

// ── programDetail 结果：Program 详情页唯一读面 ──

/** Program 视图：授权快照与交付位置（§12）；scriptText 等重字段不在 UI 读面。 */
export const continuousProgramViewSchema = z.strictObject({
  programId: idString,
  workspaceKey: nonEmptyString,
  workspacePath: nonEmptyString,
  workspaceIdentity: z.string().optional(),
  remoteSessionId: z.string().optional(),
  revision: z.number().int().positive(),
  goal: z.string(),
  timeZone: nonEmptyString,
  scope: continuousScopePolicySchema,
  budget: continuousBudgetPolicySchema,
  cadence: continuousCadencePolicySchema,
  decisionPolicy: continuousDecisionPolicySchema,
  template: continuousTemplateRefSchema,
  status: continuousProgramStatusSchema,
  statusReason: z.string().optional(),
  nextCycleAt: z.number().int().nonnegative().nullable(),
  lastCycleAt: z.number().int().nonnegative().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable(),
  /** 交付位置：独立分支与 Program worktree（D1/§7）。 */
  branchName: z.string().nullable(),
  executionPath: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ContinuousProgramView = z.infer<typeof continuousProgramViewSchema>;

/** Cycle 视图：§12 要求的 Health/最近进展/有效与墙钟时长都在这（不含脚本与快照）。 */
export const continuousCycleViewSchema = z.strictObject({
  cycleId: idString,
  sequence: z.number().int().positive(),
  status: continuousCycleStatusSchema,
  triggerKind: z.enum(["manual", "interval", "daily", "decision_resolved"]),
  healthState: continuousCycleHealthStateSchema,
  leaseEpoch: z.number().int().nonnegative(),
  resumeAttempts: z.number().int().nonnegative(),
  activeDurationMs: z.number().int().nonnegative(),
  normalBlockedDurationMs: z.number().int().nonnegative(),
  lastProgressAt: z.number().int().nonnegative().nullable(),
  lastProbeAt: z.number().int().nonnegative().nullable(),
  pendingContinuationRequestId: idString.nullable(),
  workflowRunId: nonEmptyString,
  executionSessionId: nonEmptyString,
  traceId: nonEmptyString,
  baseCommit: z.string().nullable(),
  startedAt: z.number().int().nonnegative().nullable(),
  completedAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  outcome: z.enum(["changes_verified", "no_changes", "partial"]).nullable(),
  summary: z.string().nullable(),
  changedFiles: z.array(z.string()),
  commits: z.array(z.string()),
});
export type ContinuousCycleView = z.infer<typeof continuousCycleViewSchema>;

export const continuousCandidateViewSchema = z.strictObject({
  candidateId: idString,
  title: z.string(),
  rationale: z.string(),
  targetPaths: z.array(z.string()),
  impact: z.number(),
  confidence: z.number(),
  effort: z.number(),
  risk: z.enum(["low", "medium", "high"]),
  status: continuousCandidateStatusSchema,
  sourceCycleId: idString,
  executionCycleId: idString.nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type ContinuousCandidateView = z.infer<typeof continuousCandidateViewSchema>;

export const continuousDecisionViewSchema = z.strictObject({
  decisionId: idString,
  title: z.string(),
  context: z.string(),
  options: z.array(z.strictObject({ id: idString, label: z.string(), consequences: z.string() })),
  recommendation: idString.optional(),
  classification: z.enum(["deferred", "blocking"]),
  blockingScope: z
    .strictObject({
      candidateIds: z.array(idString),
      paths: z.array(z.string()),
      capability: z.string().optional(),
    })
    .optional(),
  status: continuousDecisionStatusSchema,
  version: z.number().int().positive(),
  resolution: z
    .strictObject({
      kind: z.enum(["option", "text", "dismissed"]),
      optionId: idString.optional(),
      text: z.string().optional(),
      resolvedAt: z.number().int().nonnegative(),
    })
    .optional(),
  /** 追加的来源 Cycle（§8 重复发现合并；首见身份稳定）。 */
  sourceCycleIds: z.array(idString),
  updatedAt: z.number().int().nonnegative(),
});
export type ContinuousDecisionView = z.infer<typeof continuousDecisionViewSchema>;

/** 资源继续确认视图（§6.1）：额度/增量/等待原因等事实由服务快照给出，UI 不自行推断。 */
const continuationReasonSchema = z.enum([
  "cost_limit",
  "token_limit",
  "time_limit",
  "change_limit",
  "retry_limit",
  "resume_limit",
  "suspected_hang",
  "health_unknown",
]);

export const continuousContinuationViewSchema = z.strictObject({
  requestId: idString,
  cycleId: idString,
  version: z.number().int().positive(),
  status: z.enum(["pending", "resolved"]),
  reason: continuationReasonSchema,
  reasons: z.array(continuationReasonSchema),
  limitKind: z.enum(["cost", "token", "time", "change", "retry", "resume", "health"]),
  observedUsage: z.unknown(),
  currentLimit: z.unknown(),
  recommendedExtension: z.unknown(),
  createdAt: z.number().int().nonnegative(),
});
export type ContinuousContinuationView = z.infer<typeof continuousContinuationViewSchema>;

/** 账本摘要（§9：已结算按实际、未结算按预留；费用标“估算”，unknown 单列）。 */
export const continuousUsageSummarySchema = z.strictObject({
  settledCostMicros: z.number().int().nonnegative(),
  unsettledCostMicros: z.number().int().nonnegative(),
  settledTokens: z.number().int().nonnegative(),
  unsettledTokens: z.number().int().nonnegative(),
});
export type ContinuousUsageSummary = z.infer<typeof continuousUsageSummarySchema>;

export const continuousProgramDetailResultSchema = z.strictObject({
  program: continuousProgramViewSchema,
  currentCycle: continuousCycleViewSchema.nullable(),
  recentCycles: z.array(continuousCycleViewSchema),
  candidates: z.array(continuousCandidateViewSchema),
  decisions: z.array(continuousDecisionViewSchema),
  continuationRequest: continuousContinuationViewSchema.nullable(),
  /** 日窗口（Program 时区）与本轮的用量摘要；Unlimited 日额度时 daily 仍给出观测值。 */
  dailyUsage: continuousUsageSummarySchema,
  cycleUsage: continuousUsageSummarySchema.nullable(),
  /** workspace 执行占用（立即停止需要 epoch；§10 lease）。 */
  lease: z
    .strictObject({
      epoch: z.number().int().nonnegative(),
      ownerId: z.string().nullable(),
      cycleId: idString.nullable(),
      expiresAt: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  /** 实际运行平台并发能力（§12：不隐藏较低的机器限制；缺省 = 预算值）。 */
  platformConcurrency: z.number().int().positive(),
  at: z.number().int().nonnegative(),
});
export type ContinuousProgramDetailResult = z.infer<typeof continuousProgramDetailResultSchema>;

// ── resolveContinuation：资源继续确认的回答（§6.1 四选项）──

/** 本轮 grant 增量（与 services ContinuationGrant 同形；不重置已消耗量）。 */
export const continuousContinuationGrantSchema = z
  .strictObject({
    costMicros: z.number().int().positive().optional(),
    tokens: z.number().int().positive().optional(),
    activeDurationMs: z.number().int().positive().optional(),
  })
  .refine(
    (grant) =>
      grant.costMicros !== undefined ||
      grant.tokens !== undefined ||
      grant.activeDurationMs !== undefined,
    { message: "grant requires at least one positive increment" },
  );
export type ContinuousContinuationGrant = z.infer<typeof continuousContinuationGrantSchema>;

/** adjust_config_and_continue 的新长期配置（仅预算/时长；不改变 Scope，§6）。 */
export const continuousContinuationConfigAdjustmentSchema = z.strictObject({
  perCycleCostUsdMicros: z.number().int().positive().optional(),
  dailyCostUsdMicros: z.number().int().positive().nullable().optional(),
  perCycleTokens: z.number().int().positive().optional(),
  activeExecutionLimitMs: z.number().int().positive().optional(),
});
export type ContinuousContinuationConfigAdjustment = z.infer<
  typeof continuousContinuationConfigAdjustmentSchema
>;

export const continuousContinuationAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("continue_with_grant"),
    grant: continuousContinuationGrantSchema,
  }),
  z.strictObject({
    kind: z.literal("adjust_config_and_continue"),
    grant: continuousContinuationGrantSchema,
    configAdjustment: continuousContinuationConfigAdjustmentSchema,
  }),
  z.strictObject({ kind: z.literal("stay_paused") }),
  z.strictObject({ kind: z.literal("end_cycle") }),
]);
export type ContinuousContinuationAnswer = z.infer<typeof continuousContinuationAnswerSchema>;

export const continuousResolveContinuationResultSchema = z.strictObject({
  requestId: idString,
  status: z.enum(["pending", "resolved"]),
  version: z.number().int().positive(),
  resolutionKind: z.enum([
    "continue_with_grant",
    "adjust_config_and_continue",
    "stay_paused",
    "end_cycle",
  ]),
  /** continue 类回答恢复的 Cycle（stay_paused/end_cycle 为 null）。 */
  resumedCycleId: idString.nullable(),
});
export type ContinuousResolveContinuationResult = z.infer<
  typeof continuousResolveContinuationResultSchema
>;
