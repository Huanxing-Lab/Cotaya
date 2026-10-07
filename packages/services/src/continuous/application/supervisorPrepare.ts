// Continuous Supervisor 的 Cycle 创建与 workspace 准备（CT-13 自 supervisor.ts 拆出——
// 架构 max-file-lines 拆分，非边界变化）：模板解析 + 快照构造（终局裁决在
// supervisorLifecycle）与受管 worktree 的幂等准备。全部纯依赖注入，无自有状态。

import type { CycleTriggerKind, Cycle, Program } from "../domain/types.js";
import { createManagedCycleRecord, ContinuousSupervisorError } from "./supervisorLifecycle.js";
import type {
  ContinuousClockPort,
  ContinuousRepositoryPort,
  WorkspacePreparationPort,
} from "./ports.js";

/**
 * supervisor 交进来的依赖子集（本文件不持有实例状态）。templateSource 取结构窄视图
 * （只依赖 resolve），避免与 supervisor.ts 相互 import 形成环。
 */
export interface CyclePrepareDeps {
  repository: ContinuousRepositoryPort;
  workspace: WorkspacePreparationPort;
  clock: Pick<ContinuousClockPort, "now">;
  templateSource: {
    resolve(ref: {
      templateId: string;
      templateVersion: string;
    }): { scriptText: string; scriptHash?: string } | null;
  };
}

/** 创建受管 Cycle 行（模板 hash 不符 → 结构化拒绝，绝不带病启动；§11 template_mismatch）。 */
export async function createManagedCycleRow(
  deps: CyclePrepareDeps,
  program: Program,
  input: { triggerKey: string; triggerKind: CycleTriggerKind; requestId: string },
  baseCommit: string,
): Promise<Cycle> {
  const template = deps.templateSource.resolve({
    templateId: program.templateId,
    templateVersion: program.templateVersion,
  });
  // 授权绑定与快照构造在 supervisorLifecycle（模板 hash 不符 → 结构化拒绝，绝不带病启动）。
  const result = await createManagedCycleRecord(deps.repository, {
    program,
    triggerKey: input.triggerKey,
    triggerKind: input.triggerKind,
    requestId: input.requestId,
    baseCommit,
    template,
    now: deps.clock.now(),
  });
  if (!result.ok) throw new ContinuousSupervisorError(result.code, result.message);
  return result.cycle;
}

/**
 * workspace 准备（幂等；CT-02 的 prepare 对已登记 worktree 复用并重新解析 HEAD——
 * 每轮起始 commit 以 prepare 返回为准，不用缓存的 executionPath 冒充 baseCommit）。
 */
export async function ensureWorkspacePrepared(
  deps: CyclePrepareDeps,
  program: Program,
): Promise<{
  executionPath: string;
  branchName: string;
  baseCommit: string;
}> {
  const branchName = program.branchName ?? `codex/continuous-${program.id}`;
  const prepared = await deps.workspace.prepare({
    programId: program.id,
    workspacePath: program.workspacePath,
    baseCommit: "HEAD",
    branchName,
  });
  if (program.executionPath === undefined || program.branchName === undefined) {
    await deps.repository.saveProgram({
      ...program,
      executionPath: prepared.executionPath,
      branchName: prepared.branchName,
      updatedAt: deps.clock.now(),
    });
  }
  return {
    executionPath: prepared.executionPath,
    branchName: prepared.branchName,
    baseCommit: prepared.baseCommit,
  };
}
