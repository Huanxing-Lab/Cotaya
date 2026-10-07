/**
 * Continuous managed cycle 的**按序报告读面**（CT-03）。
 *
 * 为什么住在 `JournalStorePort` **之外**：与 listArtifactRows / listRuns 逐字同一条论证——
 * 引擎只按 runId 走自己那条链，从不为「按 journal sequence 增量读取一个 run 的全部 report」
 * 负责。把它加进领域端口，等于要求每个 journal 实现（含引擎自带的内存实现）实现一件引擎
 * 不做的事。消费方按能力探测（`typeof journal.listSequencedReportItems === "function"`）
 * 决定读面可用性。
 *
 * 为什么住在 dwf-journal.ts **之外**：这条查询只要一个 db 句柄，且自带一段「取数源为何是
 * dwf_event、游标为何是 sequence」的论证。与 dwf-journal-artifacts.ts 同一种分法。
 *
 * 为什么不沿用 run service 的 `listEvents`：那条读面经 `toProtocolEvent` 的
 * `boundDynamicWorkflowRunEventPayload` 把载荷裁到 2048 字符——对详情页事件日志是对的界，
 * 对报告导入是错的：ContinuousReportV1 条目在写入侧已经由 REPORT_CAPS 保证有界，读侧再裁
 * 一刀等于把候选/决策的证据悄悄截断。这里读 `payload_json` 原文，不做任何有界化。
 */

import type { DatabaseSync } from "node:sqlite";
import type { DwfEventRow } from "./dwf-journal-codecs.js";

/** 按序报告查询（游标 = dwf_event.sequence，与 listEvents / listArtifactItems 同一套语义）。 */
export interface DwfSequencedReportQuery {
  /** 只返回 sequence **严格大于**该值的 report 条目；缺省从头取。 */
  afterSequence?: number;
  /**
   * 单页条数上限，**必填**。存储层不替调用方猜默认值（一条无界的取数查询是这里唯一不该有的
   * 形状）；也不加自己的天花板——与 {@link import("./dwf-journal-artifacts.js").DwfArtifactItemsQuery}.limit
   * 同一条论证：调用方合法地传「钳制上限 + 1」判定 hasMore，硬顶会吃掉探测行。
   */
  limit: number;
}

/** 一条 report 条目，按 journal sequence 定位（ContinuousReportV1 的 itemKey 去重来源）。 */
export interface DwfSequencedReportItem {
  /** dwf_event.sequence：报告导入幂等去重的唯一序（规格 §11「itemKey 加来源 journal sequence」）。 */
  sequence: number;
  siteId: string;
  ordinal: number;
  /** 被报告的 item 原值（任意 JSON；写入侧 REPORT_CAPS 已保证有界）。 */
  item: unknown;
  /** 落库时刻（epoch 毫秒）；健康探活与导入审计的时钟来源。 */
  timeCreated?: number;
}

/** 宿主侧按序报告读面（dwf-journal 的 SQLite 实现携带；引擎内存 journal 不提供）。 */
export interface DwfSequencedReportQueries {
  listSequencedReportItems(runId: string, query: DwfSequencedReportQuery): DwfSequencedReportItem[];
}

/**
 * 本 run 的全部 report 条目，按 journal sequence 升序分页。
 *
 * 取数源是 **dwf_event 的 `type = 'report'` 行**，与
 * {@link import("./dwf-journal-artifacts.js").listArtifactItems} 同一张表、同一个游标语义；
 * 区别只在筛选：这里不按 `artifactId` 过滤（Continuous 的报告不依赖预置看板，未打标签的
 * report 条目同样要进导入），因此用不上 `dwf_event_artifact_idx` 表达式索引，走
 * `unique(run_id, sequence)` 主约束的顺序扫描。`limit ≤ 0` 回空页，与 listArtifactItems 同规。
 */
export function listSequencedReportItems(
  db: DatabaseSync,
  runId: string,
  query: DwfSequencedReportQuery,
): DwfSequencedReportItem[] {
  if (query.limit <= 0) return [];
  const after = query.afterSequence;
  const cursor = after === undefined ? "" : " and sequence > ?";
  const rows = db
    .prepare(
      `
      select sequence, payload_json, time_created from dwf_event
      where run_id = ?
        and type = 'report'${cursor}
      order by sequence
      limit ?
      `,
    )
    .all(runId, ...(after === undefined ? [] : [after]), query.limit) as unknown as Pick<
    DwfEventRow,
    "payload_json" | "sequence" | "time_created"
  >[];
  return rows.map((row) => {
    // payload 是被 appendEvent 原样 stringify 的 `RunEvent`，窄形状与 listArtifactItems 同源：
    // `{ type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }`。
    const payload = JSON.parse(row.payload_json) as {
      instance: { ordinal: number; siteId: string };
      item: unknown;
    };
    return {
      sequence: row.sequence,
      siteId: payload.instance.siteId,
      ordinal: payload.instance.ordinal,
      item: payload.item,
      timeCreated: row.time_created,
    };
  });
}
