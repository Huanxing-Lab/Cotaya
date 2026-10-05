// CT-12 登记载荷组装：从持久化事实（Program + Cycle 快照）与装配输入（价格快照/请求上限）
// 构造 Host→CLI 的 continuousRegisterManagedRun 载荷。纯函数、无 IO——恢复/继续路径用
// 同一实现「从持久化快照重建全部登记」（ticket CT-12），不另写第二套字段搬运。
//
// 字段来源纪律（ticket CT-12「将价格快照、请求输入/输出上限、冻结配置、角色和执行权版本
// 一并校验」）：
// - 冻结配置（scope/budget/changeLimits/角色/声明测试命令）取 Cycle.configurationSnapshot
//   与 Program 授权快照，不读实时可变配置——resume 不换脚本（§6）；
// - 并发上限来自冻结配置的 budget.maxConcurrentActors（默认 10），传入引擎 caps，不能
//   退回 CPU 默认值；
// - leaseEpoch 是执行权版本，由调用方（supervisor/恢复）在取得执行权后传入。

import type { Program, Cycle } from "../domain/types.js";
import type {
  ContinuousPriceSnapshot,
  ContinuousRegisterManagedRunCommand,
  ContinuousRequestCaps,
} from "@zcode/shared/continuous-protocol";
import { continuousRegisterManagedRunCommandSchema } from "@zcode/shared/continuous-protocol";

/** ui-ux-v1 模板的角色面（受信模板骨架；Host 侧从脚本常量对齐，不接受模型输出）。 */
const TEMPLATE_ROLES: Record<string, "observer" | "builder" | "reviewer"> = {
  observer: "observer",
  builder: "builder",
  reviewer: "reviewer",
};

export interface ManagedRunRegistrationInput {
  program: Program;
  cycle: Cycle;
  executionPath: string;
  /** 取得执行权后的 lease epoch（旧 epoch 登记在 CLI 侧被拒）。 */
  leaseEpoch: number;
  pricing: ContinuousPriceSnapshot;
  requestCaps: ContinuousRequestCaps;
  /** 单轮起始 commit（worktree HEAD；默认取 Cycle.baseCommit）。 */
  baseCommit?: string;
  /** 受控输出根（缺省由 CLI 侧自定受控目录）。 */
  outputRoot?: string;
}

export class ContinuousRegistrationPayloadError extends Error {
  constructor(
    readonly code: "registration_invalid" | "pricing_missing",
    message: string,
  ) {
    super(message);
    this.name = "ContinuousRegistrationPayloadError";
  }
}

/** 组装登记载荷并在装配侧先验一次（wire schema 的防御纵深）。 */
export function buildManagedRunRegistration(
  input: ManagedRunRegistrationInput,
): ContinuousRegisterManagedRunCommand {
  const { program, cycle } = input;
  const budget = program.budget;
  const baseCommit = input.baseCommit ?? cycle.baseCommit;
  if (baseCommit === undefined) {
    throw new ContinuousRegistrationPayloadError(
      "registration_invalid",
      `cycle ${cycle.id} 缺少单轮起始 commit（baseCommit），不能登记`,
    );
  }
  if (input.pricing.prices.length === 0) {
    // 价格缺失时费用限额下的自动执行必须拒绝并显示原因（§9）——不静默零价登记。
    throw new ContinuousRegistrationPayloadError(
      "pricing_missing",
      "价格快照为空：managed run 不能在费用限额下自动执行",
    );
  }
  const payload = {
    programId: program.id,
    cycleId: cycle.id,
    executionSessionId: cycle.executionSessionId,
    workflowRunId: cycle.workflowRunId,
    traceId: cycle.traceId,
    executionPath: input.executionPath,
    workspacePath: program.workspacePath,
    leaseEpoch: input.leaseEpoch,
    scope: program.scope,
    roles: TEMPLATE_ROLES,
    builderRole: "builder",
    declaredTestCommands: declaredTestCommandsOf(program),
    changeLimits: {
      maxFiles: budget.perCycleMaxFiles,
      maxChangedLines: budget.perCycleMaxChangedLines,
    },
    pricing: input.pricing,
    requestCaps: input.requestCaps,
    maxAttemptsPerRequest: budget.maxModelRequestAttempts,
    maxConcurrentActors: budget.maxConcurrentActors,
    baseCommit,
    ...(input.outputRoot === undefined ? {} : { outputRoot: input.outputRoot }),
  };
  // 装配侧先验：CLI 侧还有同一份 strict schema（防御纵深，两边不共享进程边界）。
  return continuousRegisterManagedRunCommandSchema.parse(payload);
}

/**
 * 声明测试命令：第一版 Program 授权面还没有逐 Program 的声明测试入口字段——如实返回空，
 * CLI 受控执行对未声明命令拒绝（test_command_not_declared → unverified，不 done 不提交，
 * fail closed）。后续产品化在 spec/授权表单补该字段时在此接上，不在载荷层造假数据。
 */
function declaredTestCommandsOf(_program: Program): Array<{ argv: string[] }> {
  return [];
}
