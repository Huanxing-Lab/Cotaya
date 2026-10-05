// ============================================================
// Continuous 操作等待登记（CT-14：完整主动探活和正常阻塞）
// ============================================================
// 修复依据：docs/tickets/continuous-release-gaps.md CT-14——「为测试、工具等操作新增实际
// 等待登记：带 owner/run/epoch、原因、开始时刻、真实期限、取消与完成通知」；过期登记
// 移除、等待失效后重新计时（docs/specs/continuous.md §10.1）。
//
// 状态所有者：执行适配器（continuous-execution-adapter）持有唯一实例；可信工具端口
//（continuous-trusted-ports）在实际操作（声明测试/浏览器验证）开始时登记、完成/取消/
// 超时后移除。健康证据聚合（continuous-health-evidence）读取登记，与 journal backoff
// 等待共同回答「全部运行节点是否都在有效等待中」——只有全部节点被覆盖才承认整轮
// normal_wait，任一 actor 仍在工作则照计有效时间。
//
// 纯进程内状态（不落库）：登记只服务探活分类，不是业务事实；执行权（epoch）前进或
// 期限到达即失效——旧执行者的等待不能豁免新轮计时（§10「旧 epoch 不可写」同款纪律）。

/** 一条实际等待的事实：owner/run/epoch、原因、开始时刻、真实期限（CT-14）。 */
export interface ContinuousOperationWaitFact {
  runId: string;
  /** 操作身份（如 `test:<candidate>:<index>`、`browser:<candidate>`）。 */
  ownerId: string;
  /** 登记时的执行权版本；高水位前进后旧登记失效。 */
  epoch: number;
  /** 原因（声明测试命令 / 浏览器验证等，供 UI 展示「正常等待原因」）。 */
  reason: string;
  startedAt: number;
  /** 真实期限：操作声明的超时/通信期限（登记方必须实际执行该期限，不能虚报）。 */
  deadlineAt: number;
}

/** 登记句柄：完成/取消通知（幂等；移除后不再豁免计时）。 */
export interface ContinuousOperationWaitHandle {
  complete(): void;
}

export interface ContinuousOperationWaitRegistry {
  /**
   * 登记一条实际等待。`signal` 联动取消：操作被取消（abort）即移除登记——取消与完成
   * 都是「等待结束」的通知路径。
   */
  register(fact: ContinuousOperationWaitFact, signal?: AbortSignal): ContinuousOperationWaitHandle;
  /**
   * 仍有效的登记：过期（deadlineAt ≤ now）与旧 epoch（< minEpoch）的登记惰性移除后
   * 返回。「等待失效后重新计时」的事实基础——失效登记不再是 normal_wait 证据。
   */
  activeOf(runId: string, now: number, minEpoch: number): ContinuousOperationWaitFact[];
}

const noopHandle: ContinuousOperationWaitHandle = { complete: () => {} };

export function createContinuousOperationWaitRegistry(): ContinuousOperationWaitRegistry {
  const waits = new Map<string, ContinuousOperationWaitFact[]>();

  return {
    register(fact, signal) {
      if (signal?.aborted) return noopHandle;
      const entries = waits.get(fact.runId) ?? [];
      // 同 ownerId 重登记覆盖旧条目（同一操作重试=新的期限，不叠证据）。
      const filtered = entries.filter((existing) => existing.ownerId !== fact.ownerId);
      filtered.push(fact);
      waits.set(fact.runId, filtered);
      let done = false;
      const remove = (): void => {
        if (done) return;
        done = true;
        const current = waits.get(fact.runId);
        if (current === undefined) return;
        waits.set(
          fact.runId,
          current.filter(
            (existing) =>
              existing.ownerId !== fact.ownerId || existing.startedAt !== fact.startedAt,
          ),
        );
      };
      signal?.addEventListener("abort", remove, { once: true });
      return { complete: remove };
    },
    activeOf(runId, now, minEpoch) {
      const entries = waits.get(runId);
      if (entries === undefined || entries.length === 0) return [];
      // 惰性清理：过期或低于当前执行权高水位的登记**永久移除**（调用方 minEpoch 是
      // 单调的执行权高水位——一旦失效的等待不能再豁免任何后续计时，fail safe）。
      const remaining = entries.filter(
        (fact) => fact.deadlineAt > now && fact.epoch >= minEpoch,
      );
      waits.set(runId, remaining);
      return [...remaining];
    },
  };
}
