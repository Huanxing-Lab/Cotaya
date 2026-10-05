// Continuous managed run 登记协议（CT-12）：Host→CLI 的专用登记命令与 CLI→Host 的
// 预算/结算/拒绝通知/决策请求的 wire 契约。规格来源：docs/specs/continuous.md §11
// （受控执行面经 v4 命令暴露）、§9（预算账本唯一写入者在 Host）、§10（租约 epoch 贯穿）。
//
// 设计边界（ticket CT-12）：CLI 在本进程构造预算/决策/IO 端口并按 Run ID 登记——Host 不导入
// Runtime、不跨 stdio 传函数。因此本协议只传**数据**：冻结配置（Scope/角色/变更量/测试命令）、
// 价格快照、请求输入/输出上限、尝试上限、执行权版本（leaseEpoch）与真实工作目录，全部 strict
// schema 校验；登记结果是 CLI 能力协商的回音（operations 词表），缺 interrupt 等新操作即视为
// CLI 太旧，Host 不给自主实施 capability。
//
// 与 continuous-execution-protocol.ts 的关系：那一份是执行端口十个操作；本文件是「提交前登记」
// 与「CLI→Host 请求」两组独立消费者，同样经 continuous-protocol.ts `export *` 再导出，公开路径
// 保持一个。本文件只做传输校验，不含业务实现、不做 IO。

import { z } from "zod";
import {
  continuousPriceSnapshotSchema,
  continuousRequestCapsSchema,
} from "./continuous-budget-protocol.js";
import { continuousScopePolicySchema } from "./continuous-ui-protocol.js";

const nonEmptyString = z.string().min(1);
const idString = z.string().min(1);
const epochSchema = z.number().int().nonnegative();

/**
 * CLI 受控执行面必须完整支持的操作词表（能力协商的判据）。CT-12 起登记命令的结果必须
 * 回报这份词表；Host 逐一核对——缺任一项（典型：旧 CLI 没有 interrupt）即拒绝自主实施。
 * 词表与 continuousManagedCycleOpSchema 的十个 op 保持同一份语义，新增 op 是协议变更。
 */
export const CONTINUOUS_CLI_MANAGED_OPERATIONS = [
  "register",
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
] as const;
export type ContinuousCliManagedOperation = (typeof CONTINUOUS_CLI_MANAGED_OPERATIONS)[number];

/** 受管 actor 的角色（与 bootstrap ContinuousActorRole 同一词表；未知角色登记拒绝）。 */
export const continuousActorRoleSchema = z.enum(["observer", "builder", "reviewer"]);
export type ContinuousActorRoleWire = z.infer<typeof continuousActorRoleSchema>;

/** 声明测试命令：完整 argv，spawn(file, args) 直传，绝不经 shell（规格 §7）。 */
export const continuousDeclaredTestCommandSchema = z.strictObject({
  argv: z.array(nonEmptyString).min(1),
});
export type ContinuousDeclaredTestCommandWire = z.infer<typeof continuousDeclaredTestCommandSchema>;

/**
 * Host→CLI 登记载荷：一个 managed run 的全部冻结事实。字段按「谁来裁决」分组——
 * 执行身份四元组 + programId（Host 持久化事实）；executionPath/leaseEpoch（执行权与真实
 * 工作目录）；scope/roles/changeLimits/declaredTestCommands/baseCommit（IO 冻结配置）；
 * pricing/requestCaps/maxAttemptsPerRequest（预算闸门构造输入）；maxConcurrentActors
 * （并发上限来自冻结配置，传入引擎 caps，不能退回 CPU 默认值——ticket CT-12）。
 */
export const continuousRegisterManagedRunCommandSchema = z.strictObject({
  programId: idString,
  cycleId: idString,
  executionSessionId: idString,
  workflowRunId: idString,
  traceId: idString,
  /** Program worktree：actor 实际 cwd；与登记外的路径不符即拒绝（防串任务）。 */
  executionPath: nonEmptyString,
  /** 原始仓库路径：只用于身份与展示，禁止执行期读写（E-02）。 */
  workspacePath: nonEmptyString,
  /** 取得执行权后的 lease epoch；旧 epoch 的登记拒绝（§10「旧 epoch 不可写」）。 */
  leaseEpoch: epochSchema,
  scope: continuousScopePolicySchema,
  /** 模板角色名 → 执行角色；从受信模板取授权，不能根据模型输出决定角色。 */
  roles: z.record(z.string(), continuousActorRoleSchema),
  /** 单 builder 的模板角色名（缺省 builder）；该角色获得写许可面。 */
  builderRole: nonEmptyString.optional(),
  declaredTestCommands: z.array(continuousDeclaredTestCommandSchema),
  /** 变更量上限（相对单轮起始 commit 累计；§2/§7）。 */
  changeLimits: z.strictObject({
    maxFiles: z.number().int().positive(),
    maxChangedLines: z.number().int().positive(),
  }),
  /** 预算闸门构造输入：价格快照缺失该 model 即 pricing_missing 拒绝（§9）。 */
  pricing: continuousPriceSnapshotSchema,
  requestCaps: continuousRequestCapsSchema,
  maxAttemptsPerRequest: z.number().int().positive(),
  /** 冻结配置的并发上限（默认 10）；CLI 引擎 caps 取此值，不退回 CPU 默认。 */
  maxConcurrentActors: z.number().int().positive(),
  /** 单轮起始 commit（worktree HEAD；变更量累计的基准）。 */
  baseCommit: nonEmptyString,
  /** 控制输出根（受控执行输出/证据落盘）；缺省由 CLI 侧自定受控目录。 */
  outputRoot: z.string().optional(),
});
export type ContinuousRegisterManagedRunCommand = z.infer<
  typeof continuousRegisterManagedRunCommandSchema
>;

/** 登记拒绝词表（fault.command.continuousRegisterManagedRunRejected.<reason>）。 */
export const continuousRegistrationRejectionReasonSchema = z.enum([
  // 身份/执行权：与执行端口同名同义的裁决在登记面的投影。
  "execution_identity_mismatch",
  "lease_lost",
  // 构造输入非法（caps 非正整数、价格表为空、角色表含未知面）。
  "registration_invalid",
  // CLI 侧未装配（功能关闭/stub 宿主）——等同能力不支持，绝不退回普通执行。
  "capability_missing",
]);
export type ContinuousRegistrationRejectionReason = z.infer<
  typeof continuousRegistrationRejectionReasonSchema
>;

/**
 * 登记结果：CLI 回报自己实际支持的操作词表（能力协商）。Host 逐一核对
 * CONTINUOUS_CLI_MANAGED_OPERATIONS——不完整即 CLI 太旧，自主实施 capability 不开放。
 */
export const continuousRegisterManagedRunResultSchema = z.strictObject({
  type: z.literal("continuousRegisterManagedRun"),
  operations: z.array(nonEmptyString),
  /** 登记落点（runId）回显；与命令身份不符即拒绝。 */
  workflowRunId: idString,
});
export type ContinuousRegisterManagedRunResult = z.infer<
  typeof continuousRegisterManagedRunResultSchema
>;

export const CONTINUOUS_REGISTER_MANAGED_RUN_REJECTED_FAULT_PREFIX =
  "fault.command.continuousRegisterManagedRunRejected." as const;

/** 能力协商核对：CLI 回报的操作词表是否覆盖全部必需操作（含 interrupt）。 */
export function supportsContinuousCliManagedOperations(operations: readonly string[]): boolean {
  return CONTINUOUS_CLI_MANAGED_OPERATIONS.every((operation) => operations.includes(operation));
}

// ── CLI→Host 请求（预算账本/拒绝通知/决策持久化；宿主侧在 agent 服务的 client request
// 路径拦截，词表与方法同 zcodeProtocolMethods 家族）──────────────────────────────

export const CONTINUOUS_AGENT_REQUEST_METHODS = {
  ledgerReserve: "continuous/ledger/reserve",
  ledgerSettle: "continuous/ledger/settle",
  budgetSuspension: "continuous/budget/suspend",
  decisionEscalation: "continuous/decision/escalate",
} as const;
export type ContinuousAgentRequestMethod =
  (typeof CONTINUOUS_AGENT_REQUEST_METHODS)[keyof typeof CONTINUOUS_AGENT_REQUEST_METHODS];

/** 预留请求（CLI 铸 requestKey，Host 账本原子准入；字段与 bootstrap 账本窄端口一致）。 */
export const continuousLedgerReserveParamsSchema = z.strictObject({
  programId: idString,
  cycleId: idString,
  workflowRunId: idString,
  requestKey: nonEmptyString,
  provider: nonEmptyString,
  model: nonEmptyString,
  pricingVersion: nonEmptyString,
  reservedCostMicros: z.number().int().nonnegative(),
  reservedTokens: z.number().int().nonnegative(),
});
export type ContinuousLedgerReserveParams = z.infer<typeof continuousLedgerReserveParamsSchema>;

export const continuousLedgerReserveResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), requestKey: nonEmptyString }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["budget_denied", "admission_closed", "ledger_unreachable"]),
    message: nonEmptyString,
    /** budget_denied 附带结构化观测（limitKind/已用/预留/限额），不只回错误文字（§11/CT-13 前置）。 */
    denial: z
      .strictObject({
        limitKind: z.enum(["cycle_cost", "cycle_tokens", "daily_cost"]),
        cycleSummary: z.strictObject({
          settledCostMicros: z.number().int().nonnegative(),
          reservedCostMicros: z.number().int().nonnegative(),
          unknownCostMicros: z.number().int().nonnegative(),
          settledTokens: z.number().int().nonnegative(),
          reservedTokens: z.number().int().nonnegative(),
        }),
        dailySummary: z
          .strictObject({
            settledCostMicros: z.number().int().nonnegative(),
            reservedCostMicros: z.number().int().nonnegative(),
            unknownCostMicros: z.number().int().nonnegative(),
          })
          .optional(),
      })
      .optional(),
  }),
]);
export type ContinuousLedgerReserveResult = z.infer<typeof continuousLedgerReserveResultSchema>;

/** 结算请求（幂等；state=unknown 保留预留，§9）。 */
export const continuousLedgerSettleParamsSchema = z.strictObject({
  requestKey: nonEmptyString,
  state: z.enum(["settled", "unknown"]),
  actualTokens: z.number().int().nonnegative().optional(),
  estimatedCostMicros: z.number().int().nonnegative().optional(),
  usage: z.unknown().optional(),
});
export type ContinuousLedgerSettleParams = z.infer<typeof continuousLedgerSettleParamsSchema>;

export const continuousLedgerSettleResultSchema = z.strictObject({ accepted: z.literal(true) });

/**
 * 预算拒绝通知（§2.1 修复边界）：CLI 本地准入状态是唯一所有者——闸门释放并发座位后通知
 * Host 保存同轮暂停与继续确认，再等待同一所有者的显式恢复。Host 收到即走
 * suspendCycleForBudget 链（cycle suspended + program paused + 同轮唯一 pending 确认）。
 * change_limit 是变更量上限的同轮挂起（CT-11 第 6 条：继续只增加本轮额度）。
 */
export const continuousBudgetSuspensionParamsSchema = z.strictObject({
  programId: idString,
  cycleId: idString,
  workflowRunId: idString,
  /** 触发暂停的拒绝码（budget_denied/admission_closed）或变更量上限（change_limit）。 */
  code: z.enum(["budget_denied", "admission_closed", "change_limit"]),
  message: z.string().min(1).max(1024),
  /** change_limit 附带上限种类与投影值（Host 映射 continuation 的 limitKind/reason）。 */
  limitKind: z.enum(["file_limit", "line_limit"]).optional(),
});
export type ContinuousBudgetSuspensionParams = z.infer<
  typeof continuousBudgetSuspensionParamsSchema
>;

export const continuousBudgetSuspensionResultSchema = z.strictObject({
  /** 已存在的 pending 确认幂等复用（同轮合并，不重复弹窗，§5）。 */
  continuationRequestId: nonEmptyString,
});

/**
 * 决策请求（§8）：执行中发现需决策事项，CLI 经此持久化 Decision（先持久化再撤销写许可），
 * 不 await 人类输入。载荷与 bootstrap ContinuousDecisionRecordInput 结构一致。
 */
export const continuousDecisionEscalationParamsSchema = z.strictObject({
  programId: idString,
  cycleId: idString,
  workflowRunId: idString,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  title: nonEmptyString,
  context: z.string(),
  options: z
    .array(
      z.strictObject({
        id: nonEmptyString,
        label: nonEmptyString,
        consequences: z.string(),
      }),
    )
    .min(1),
  recommendation: z.string().optional(),
  classification: z.enum(["deferred", "blocking"]),
  blockingScope: z
    .strictObject({
      candidateIds: z.array(nonEmptyString),
      paths: z.array(z.string()),
      capability: z.string().optional(),
    })
    .optional(),
  evidence: z.array(z.unknown()).optional(),
});
export type ContinuousDecisionEscalationParams = z.infer<
  typeof continuousDecisionEscalationParamsSchema
>;

export const continuousDecisionEscalationResultSchema = z.strictObject({
  decisionId: nonEmptyString,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["pending", "resolved", "dismissed"]),
  merged: z.boolean(),
});
export type ContinuousDecisionEscalationResult = z.infer<
  typeof continuousDecisionEscalationResultSchema
>;
