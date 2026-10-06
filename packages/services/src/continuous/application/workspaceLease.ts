// Continuous workspace 执行占用（CT-07；规格 §5/§10）。
//
// 本文件是 lease 的应用层唯一裁决点：epoch 单调、正常释放保留 epoch 且 cycle/owner/expiry
// 同空、过期不直接接管——先核对旧 owner/attachment，撤销旧许可并确认旧执行停止后才允许
// 增加 epoch 接管；无法确认则保持现状，不创建替代执行（R-06/E-19/I-11）。
// 存储层（sqliteLifecycleStore）用 CHECK/UNIQUE 兜底「三者同有同空」与 epoch 单调；
// 本层在其上补齐核对顺序与副作用守卫。expires_at 只是续租期限，不是进程死亡证明。
//
// 纯库函数（无后台线程/定时器）：续租节拍由调用方（supervisor 监督循环）驱动。

import type { ContinuousErrorCode } from "@zcode/shared";
import type { Cycle, WorkspaceLease } from "../domain/types.js";
import { isOpenCycleStatus } from "../domain/types.js";
import type { ContinuousClockPort, ContinuousExecutionPort } from "./ports.js";
import type { ContinuousRepositoryPort } from "./ports.js";

/** 租约期限（§10：默认 90 秒）；到期未续租只代表「需要核对」，不等于 owner 已死。 */
export const CONTINUOUS_LEASE_TERM_MS = 90_000;
/** 续租间隔（§10：30 秒续租）；失去续租的执行者必须立刻停止新操作。 */
export const CONTINUOUS_LEASE_RENEW_INTERVAL_MS = 30_000;

/** lease 丢失/不可取得的结构化错误（词表复用 shared 的 lease_lost）。 */
export class ContinuousLeaseLostError extends Error {
  readonly code: ContinuousErrorCode = "lease_lost";
  constructor(message: string) {
    super(message);
    this.name = "ContinuousLeaseLostError";
  }
}

/** lease 裁决需要的依赖子集（supervisor/recovery 交进来；测试可独立注入）。 */
export interface WorkspaceLeaseDeps {
  repository: Pick<
    ContinuousRepositoryPort,
    "getLease" | "acquireLease" | "renewLease" | "releaseLease" | "getCycle"
  >;
  execution: Pick<
    ContinuousExecutionPort,
    // CT-16：接管的防御性撤销从 stop（用户停止语义）改为 interrupt（interrupted 语义，
    // 保留同 Run 可恢复性）；stop 保留给用户/配置变更的显式停止链。
    "inspect" | "inspectHealth" | "stop" | "interrupt" | "waitForQuiescence"
  >;
  clock: Pick<ContinuousClockPort, "now">;
}

export type LeaseAcquireResult =
  | { status: "acquired"; epoch: number }
  | { status: "renewed"; epoch: number }
  | {
      /** 不接管的原因：占用中（未过期或占用者是未结束 Cycle）/ 旧执行者仍活着。 */
      status: "refused";
      reason: "held" | "old_owner_alive";
      epoch: number;
    };

function referenceOf(cycle: Cycle) {
  return {
    cycleId: cycle.id,
    executionSessionId: cycle.executionSessionId,
    workflowRunId: cycle.workflowRunId,
    traceId: cycle.traceId,
  };
}

/**
 * 取得（或核对后接管）workspace 执行占用：
 *  - 无行/已释放（cycle 为空）→ 以 epoch+1 取得；
 *  - 同 Cycle 同 owner 重入 → 幂等续租（重放 Run now/恢复流程不重复抬 epoch）；
 *  - 同 Cycle 不同 owner（Host 重启后的恢复）→ 核对旧 owner 死亡（不可达+静默）后接管
 *    ——租期未过也不能凭期限拒绝：expires_at 不是进程死亡证明，可达性才是核对依据；
 *  - 其它 Cycle 占用：占用者是未结束 Cycle（含 suspended 的资源暂停保留占用）一律拒绝；
 *    终态 Cycle 的残留占用（结算后释放前崩溃）在过期后按同一核对流程接管。
 * 拒绝时返回 refused，不抛异常——「不能接管」是业务结果（I-11），调用方据此跳过或保持 interrupted。
 */
export async function acquireCycleLease(
  deps: WorkspaceLeaseDeps,
  input: { workspaceKey: string; cycleId: string; ownerId: string },
): Promise<LeaseAcquireResult> {
  const existing = await deps.repository.getLease(input.workspaceKey);
  const now = deps.clock.now();
  if (existing === null) {
    const epoch = 1;
    await writeAcquire(deps, input, epoch, now);
    return { status: "acquired", epoch };
  }
  if (existing.cycleId === undefined) {
    // 正常释放后的空占用：epoch 保留单调，新执行者以 epoch+1 取得（§5）。
    const epoch = existing.epoch + 1;
    await writeAcquire(deps, input, epoch, now);
    return { status: "acquired", epoch };
  }
  const held = existing.cycleId === input.cycleId;
  if (held && existing.ownerId === input.ownerId) {
    // 同 Cycle 同 owner 的重入（幂等重放）：只延长租期，不抬 epoch。
    const expiresAt = now + CONTINUOUS_LEASE_TERM_MS;
    await deps.repository.renewLease({
      workspaceKey: input.workspaceKey,
      ownerId: input.ownerId,
      epoch: existing.epoch,
      expiresAt,
      updatedAt: now,
    });
    return { status: "renewed", epoch: existing.epoch };
  }
  if (!held) {
    // 其它 Cycle 占用：未结束 Cycle（运行/挂起/中断）保留占用权——资源暂停后不释放执行占用，
    // 防止另一轮覆盖待恢复工作（§10/E-19）；终态残留才可在过期后接管。
    const occupant = await deps.repository.getCycle(existing.cycleId);
    const occupantOpen = occupant !== null && isOpenCycleStatus(occupant.status);
    if (occupantOpen || existing.expiresAt === undefined || existing.expiresAt > now) {
      return { status: "refused", reason: "held", epoch: existing.epoch };
    }
  }
  // 同 Cycle 不同 owner（Host 重启后的恢复——无论租期是否已过，期限不是死亡证明），或
  // 终态残留的过期占用：先核对旧 owner/attachment（R-06）。旧执行者仍可达且 Run 未终态
  // → 不启动第二写入者；不可达才撤销旧许可、确认停止后接管。
  if (existing.ownerId !== undefined) {
    const occupant = await deps.repository.getCycle(existing.cycleId!);
    if (occupant !== null) {
      const ref = referenceOf(occupant);
      const health = await deps.execution.inspectHealth(ref);
      const state = await deps.execution.inspect(ref);
      const alive = health.reachable && (state.status === "running" || state.status === "pending");
      if (alive && held) {
        // 旧 owner 还活着：保持现状（不接管、不创建替代 Run），交由占用方继续或后续核对。
        return { status: "refused", reason: "old_owner_alive", epoch: existing.epoch };
      }
      // 撤销旧许可并确认停止（CT-16 修复：改用 interrupt 语义）。修复依据：上方的 alive
      // 判定已排除「可达且 running/pending」的活执行者——接管分支面对的只有已中断/冷执行
      // 面。此前的防御性 `stop` 是用户停止语义（CLI 侧 admission 永久 revoked，§6「用户
      // 取消的 Run 不自动恢复」），落在重启后复活的冷执行会话上会把紧随其后的同 Run 恢复
      // （resumeInterrupted → execution.resume 的 requireNotRevoked）毒化成 stopped 拒绝
      // （实测 packaged E-17：cycle failed + resume_limit 语义被误用）。interrupt 语义才是
      // 这里的正确动词：以 interrupted 原因取消引擎、冻结准入但保留可恢复性（§10「退出
      // 中断保存 interrupted，同 Run 安全恢复」）；对真正不可达的执行者两者同样尽力而为
      // （传输失败被吞），对冷行 cancel 为 no-op、waitForQuiescence 立即返回。
      try {
        await deps.execution.interrupt(ref, occupant.leaseEpoch);
      } catch {
        // 不可达执行者的 interrupt 可能失败；可达性已排除活执行者，这里不吞接管依据。
      }
      await deps.execution.waitForQuiescence(ref);
    }
  }
  const epoch = existing.epoch + 1;
  await writeAcquire(deps, input, epoch, now);
  return { status: "acquired", epoch };
}

async function writeAcquire(
  deps: WorkspaceLeaseDeps,
  input: { workspaceKey: string; cycleId: string; ownerId: string },
  epoch: number,
  now: number,
): Promise<void> {
  // epoch 单调由存储层强制（acquireLease 要求 > 现存值）；期限 90 秒，续租归 renewLease。
  await deps.repository.acquireLease({
    workspaceKey: input.workspaceKey,
    cycleId: input.cycleId,
    ownerId: input.ownerId,
    epoch,
    expiresAt: now + CONTINUOUS_LEASE_TERM_MS,
    updatedAt: now,
  });
}

/**
 * 副作用守卫（§10「epoch 必须到达启动、请求准入、工具操作和报告提交」）：
 * 旧 epoch/已释放/他人接管的写入一律 lease_lost。用途字符串进错误信息便于审计。
 * 注意：不检查 expires_at——过期未被接管前 owner 仍有效，失去续租由执行者侧纪律停止新操作。
 */
export async function requireLeaseEpoch(
  deps: Pick<WorkspaceLeaseDeps, "repository">,
  input: { workspaceKey: string; epoch: number; ownerId?: string; purpose: string },
): Promise<WorkspaceLease> {
  const lease = await deps.repository.getLease(input.workspaceKey);
  if (
    lease === null ||
    lease.cycleId === undefined ||
    lease.epoch !== input.epoch ||
    (input.ownerId !== undefined && lease.ownerId !== input.ownerId)
  ) {
    throw new ContinuousLeaseLostError(
      `lease 校验失败（${input.purpose}）: epoch=${input.epoch} ownerId=${input.ownerId ?? "-"}，` +
        `当前=${lease === null ? "无行" : `epoch=${lease.epoch} cycle=${lease.cycleId ?? "-"} owner=${lease.ownerId ?? "-"}`}`,
    );
  }
  return lease;
}

/** 续租：当前 owner/epoch 匹配则延长 90 秒；任何不匹配抛 lease_lost（调用方立刻停新操作）。 */
export async function renewCycleLease(
  deps: WorkspaceLeaseDeps,
  input: { workspaceKey: string; ownerId: string; epoch: number },
): Promise<void> {
  const now = deps.clock.now();
  try {
    await deps.repository.renewLease({
      workspaceKey: input.workspaceKey,
      ownerId: input.ownerId,
      epoch: input.epoch,
      expiresAt: now + CONTINUOUS_LEASE_TERM_MS,
      updatedAt: now,
    });
  } catch (error) {
    throw new ContinuousLeaseLostError(
      `lease 续租失败（${input.workspaceKey} epoch=${input.epoch}）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** 正常释放：校验归属后置空 cycle/owner/expiry，epoch 保留（资源暂停路径不要调用本函数）。 */
export async function releaseCycleLease(
  deps: WorkspaceLeaseDeps,
  input: { workspaceKey: string; ownerId: string; epoch: number },
): Promise<void> {
  await requireLeaseEpoch(deps, {
    workspaceKey: input.workspaceKey,
    ownerId: input.ownerId,
    epoch: input.epoch,
    purpose: "release",
  });
  await deps.repository.releaseLease(input.workspaceKey, deps.clock.now());
}
