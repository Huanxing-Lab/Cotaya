// 只读取已落库动作的时间；反复查询不能把旧动作刷新成“刚有进展”。
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import type { HealthSnapshot } from "./continuous-execution-contract.js";

export function createContinuousHealthEvidence(journal: JournalStorePort) {
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
  return (runId: string): Pick<HealthSnapshot, "lastProgressAt" | "waitingFor"> => {
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
    const waits = pending.map((node) => state.waits.get(keyOf(node)));
    const allWaiting =
      page.length < 256 && waits.length > 0 && waits.every((wait) => wait !== undefined);
    const waitingFor = allWaiting
      ? waits.reduce((earliest, wait) =>
          wait!.deadlineAt < earliest!.deadlineAt ? wait : earliest,
        )
      : undefined;
    return {
      ...(state.lastProgressAt === undefined ? {} : { lastProgressAt: state.lastProgressAt }),
      ...(waitingFor === undefined ? {} : { waitingFor }),
    };
  };
}
