import { resolve } from "node:path";
import type { ContinuousModelBudgetGate } from "./continuous-model-budget.js";
import type { ContinuousDecisionGate } from "./continuous-decision-adapter.js";
import type { ContinuousActorIoPolicy } from "./continuous-io-guards.js";
import type { ContinuousTrustedDispatch } from "./continuous-trusted-ports.js";
import type { ContinuousConfinedTestRunner } from "./continuous-confined-execution.js";
import {
  ContinuousExecutionError,
  type ManagedCycleInput,
} from "./continuous-execution-adapter.js";

export interface ContinuousManagedIoRegistration {
  executionPath: string;
  /** 从受信模板的角色名取授权，不能根据模型输出决定角色。 */
  actorPolicyFor(name: string | undefined): ContinuousActorIoPolicy;
  worldPolicy: ContinuousActorIoPolicy;
  /**
   * CT-11 可信工具端口（continuous-test/-diff/-browser/-commit）：只进入 world 端口
   * （模板骨架面），测试/浏览器/Git diff 证据与受控本地提交的唯一产生点。
   */
  trusted?: ContinuousTrustedDispatch;
  /**
   * CT-11 受控测试执行 runner（固定 cwd/环境/超时/输出/取消 + 已自证隔离）。
   * 缺席或隔离未自证时，声明测试命令按 confined_execution_not_supported 拒绝。
   */
  testRunner?: ContinuousConfinedTestRunner;
}

export interface ContinuousManagedGuardRegistry {
  modelBudgetGateFor?: (runId: string) => ContinuousModelBudgetGate | undefined;
  decisionGateFor?: (runId: string) => ContinuousDecisionGate | undefined;
  executionPolicyFor?: (runId: string) => ContinuousManagedIoRegistration | undefined;
}

export function requireContinuousManagedGuards(
  registry: ContinuousManagedGuardRegistry | undefined,
  input: ManagedCycleInput,
): void {
  requireContinuousRunRegistration(registry, input.workflowRunId, input.executionPath);
}

export function requireContinuousRunRegistration(
  registry: ContinuousManagedGuardRegistry | undefined,
  runId: string,
  executionPath: string | undefined,
): void {
  const budget = registry?.modelBudgetGateFor?.(runId);
  const decisions = registry?.decisionGateFor?.(runId);
  const io = registry?.executionPolicyFor?.(runId);
  // 缺登记不能回退普通工作流端口，否则打开功能开关就绕过全部边界。
  if (
    !budget?.supportsSuspension ||
    !decisions ||
    !io ||
    !executionPath ||
    resolve(io.executionPath) !== resolve(executionPath)
  ) {
    throw new ContinuousExecutionError(
      "execution_identity_mismatch",
      "continuous managed run guards are missing or bound to another worktree",
    );
  }
}
