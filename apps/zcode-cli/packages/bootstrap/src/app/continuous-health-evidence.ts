// 只读取已落库动作的时间；反复查询不能把旧动作刷新成“刚有进展”。
// CT-14：journal backoff 等待与操作等待登记（测试/工具等实际等待）共同回答「全部运行
// 节点是否都在有效等待中」——只有全部节点被有效等待覆盖才承认整轮 normal_wait；任一
// actor 仍在工作（未被覆盖）则不豁免整轮有效时间（docs/specs/continuous.md §10.1）。
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import type {
  ContinuousOperationWaitRegistry,
} from "./continuous-operation-waits.js";
import type { HealthSnapshot } from "./continuous-execution-contract.js";

export interface ContinuousHealthEvidenceDeps {
  /**
   * CT-14 操作等待登记（normal_wait 证据来源之二）：登记由可信工具端口在实际操作
   * （声明测试/浏览器验证）开始时写入。缺省缺席——没有登记就没有等待证据，时间照计
   *（fail closed：不能凭进程存活/heartbeat 豁免计时）。
   */
  operationWaits?: ContinuousOperationWaitRegistry;
  /** 读取时刻（缺省 Date.now）；过期登记按此判定移除。 */
  now?: () => number;
}

export function createContinuousHealthEvidence(
  journal: JournalStorePort,
  deps: ContinuousHealthEvidenceDeps = {},
) {
  const runs = new Map<
    string,
    {
      cursor: number;
      lastProgressAt?: number;
      waits: Map<string, NonNullable<HealthSnapshot["waitingFor"]>>;
    }
  >();
  const keyOf = (instance: { siteId: string; ordinal: number }) =>
    `${instance.siteId}:${instance.ordinal}`;
  return (
    runId: string,
    /** 执行权高水位（执行适配器传入）：旧 epoch 的登记不作数（CT-14）。 */
    minEpoch = 0,
  ): Pick<HealthSnapshot, "lastProgressAt" | "waitingFor"> => {
    let state = runs.get(runId);
    if (!state) {
      state = { cursor: -1, waits: new Map() };
      runs.set(runId, state);
    }
    // 每次读取有界增量；历史过多时继续下一探活页，不用查询时间冒充历史事件时间。
    const page = journal.listEvents(runId, { afterSequence: state.cursor, limit: 256 });
    for (const row of page) {
      state.cursor = row.sequence;
      const event = row.event;
      if (
        row.timeCreated !== undefined &&
        event.type !== "log" &&
        event.type !== "concurrency-changed"
      ) {
        state.lastProgressAt = Math.max(state.lastProgressAt ?? 0, row.timeCreated);
      }
      if (event.type === "node-waiting") {
        const key = keyOf(event.instance);
        state.waits.delete(key);
        // slot 没有期限，不认作正常阻塞；backoff 的实际调度延迟来自 runner 的落库事件。
        if (
          event.cause === "backoff" &&
          row.timeCreated !== undefined &&
          event.delayMs !== undefined &&
          event.delayMs > 0 &&
          event.reason
        ) {
          state.waits.set(key, {
            ownerId: `${runId}:${key}`,
            reason: event.reason,
            deadlineAt: row.timeCreated + event.delayMs,
          });
        }
      } else if (event.type === "node-executing" || event.type === "node-settled") {
        state.waits.delete(keyOf(event.instance));
      }
    }
    const pending = journal.listNodes(runId).filter((node) => node.status === "running");
    const journalWaits = pending.map((node) => state.waits.get(keyOf(node)));
    // CT-14 覆盖规则：journal 等待覆盖一部分运行节点；其余节点由操作等待登记覆盖
    //（一次登记对应一个节点内的真实长操作）。未被覆盖的节点 = 仍有 actor 在工作。
    const now = deps.now?.() ?? Date.now();
    const registered = deps.operationWaits?.activeOf(runId, now, minEpoch) ?? [];
    const uncovered =
      journalWaits.filter((wait) => wait === undefined).length - registered.length;
    const allWaiting = page.length < 256 && pending.length > 0 && uncovered <= 0;
    const candidates = [
      ...journalWaits.filter((wait): wait is NonNullable<HealthSnapshot["waitingFor"]> => !!wait),
      // 登记等待快照化（ownerId/reason/deadlineAt 三件套与 journal 等待同形）。
      ...registered.map((fact) => ({
        ownerId: fact.ownerId,
        reason: fact.reason,
        deadlineAt: fact.deadlineAt,
      })),
    ];
    const waitingFor = allWaiting && candidates.length > 0
      ? candidates.reduce((earliest, wait) =>
          wait.deadlineAt < earliest.deadlineAt ? wait : earliest,
        )
      : undefined;
    return {
      ...(state.lastProgressAt === undefined ? {} : { lastProgressAt: state.lastProgressAt }),
      ...(waitingFor === undefined ? {} : { waitingFor }),
    };
  };
}
