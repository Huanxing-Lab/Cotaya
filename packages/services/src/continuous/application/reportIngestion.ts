// Continuous 报告导入（CT-05，规格 §11）：schema 校验后事务导入。
//
// 规则来源：docs/specs/continuous.md §11（版本化 ContinuousReportV1、itemKey 加来源 journal
// sequence 去重、schema 校验后事务导入、Run 失败也导入已保存报告、malformed report 记录
// 拒绝事件且不能据此 done/提交）与 §7（测试/浏览器/独立 Review 全部通过才允许提交）。
//
// 单一写入路径：本类把一个报告批次编排成 ReportImportInput 交给
// repository.applyReportImport —— 队列/关联/事件/cursor 同一事务（CT-01 落地），
// 中断无半条队列（I-03）；重放凭 event_key/UNIQUE(program_id,fingerprint) 幂等。
//
// done 门槛（E-12「模型“已通过”文本不能覆盖事实」的 Host 侧防线）：candidate_result
// status=done 只有在该 candidateKey 的 tests/browser/review 三阶段 validation 事实
// （本批 + 已导入事件）全部 passed 时才被采信；不满足 → 记拒绝事件，结果标记 gated，
// 结算方（supervisor）不得据此 done/提交。跨批次读回经 listCycleEvents——readReports
// 分页可能把 validation 与 candidate_result 切进两批。

import { createHash } from "node:crypto";
import {
  parseContinuousReportV1Item,
  type ContinuousReportCandidateItem,
  type ContinuousReportCandidateResultItem,
  type ContinuousReportCycleResultItem,
  type ContinuousReportDecisionItem,
} from "@zcode/shared";
import type { Candidate, ContinuousEvent, Decision, ReportImportItem } from "../domain/types.js";
import { continuousDecisionRowId } from "./continuousIds.js";
import type { ContinuousReportItem } from "./ports.js";
import type { ContinuousClockPort, ContinuousRepositoryPort } from "./ports.js";

/** 三阶段验证全部通过才允许 done（规格 §7 固定骨架）。 */
const REQUIRED_VALIDATION_STAGES = ["tests", "browser", "review"] as const;

export interface ReportIngestionDeps {
  repository: ContinuousRepositoryPort;
  clock: Pick<ContinuousClockPort, "now">;
}

/** 一条 candidate_result 的导入结论：gated=false 表示 done 未被采信（拒绝事件已记）。 */
export interface IngestedCandidateResult {
  item: ContinuousReportCandidateResultItem;
  /** schema 合法但 done 未过三阶段验证门（或本身不是 done）。 */
  doneAccepted: boolean;
  gateReason?: string;
}

export interface ReportRejection {
  itemKey: string;
  journalSequence: number;
  reason: string;
}

export interface ReportIngestionOutcome {
  imported: {
    candidates: number;
    decisions: number;
    validations: number;
    candidateResults: number;
    cycleResults: number;
  };
  rejected: ReportRejection[];
  /** 同 candidateKey 以最后一条为准（模板按序上报，后报覆盖先报）。 */
  candidateResults: Map<string, IngestedCandidateResult>;
  /** 候选 itemKey → 候选行 id（含本批与此前批次；结算方据此回写队列状态）。 */
  itemKeyToCandidateId: Map<string, string>;
  cycleResult?: ContinuousReportCycleResultItem;
  /** 同事务推进后的 journal sequence 游标。 */
  nextCursor: number;
}

export interface ReportBatchInput {
  programId: string;
  cycleId: string;
  items: ContinuousReportItem[];
  nextCursor: number;
}

/** 候选行 id：由 fingerprint 确定派生（UNIQUE(program_id,fingerprint) 的稳定主键）。 */
function candidateIdOf(fingerprint: string): string {
  return `cand:${createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 24)}`;
}

export class ContinuousReportIngestion {
  constructor(private readonly deps: ReportIngestionDeps) {}

  /** 导入一个报告批次（一个事务）；失败条目记拒绝事件，不阻断批次内其余条目。 */
  async ingestBatch(input: ReportBatchInput): Promise<ReportIngestionOutcome> {
    const now = this.deps.clock.now();
    const items: ReportImportItem[] = [];
    const outcome: ReportIngestionOutcome = {
      imported: {
        candidates: 0,
        decisions: 0,
        validations: 0,
        candidateResults: 0,
        cycleResults: 0,
      },
      rejected: [],
      candidateResults: new Map(),
      itemKeyToCandidateId: new Map(),
      nextCursor: input.nextCursor,
    };

    // 跨批次事实：已导入的 validation/candidate 事件（done 门与决策关联的读回）。
    const priorEvents = await this.deps.repository.listCycleEvents(input.programId, input.cycleId);
    const passedStages = new Map<string, Set<string>>();
    const fingerprintByItemKey = new Map<string, string>();
    for (const event of priorEvents) {
      readPriorFact(event, passedStages, fingerprintByItemKey);
    }
    for (const [itemKey, fingerprint] of fingerprintByItemKey) {
      // id 由 fingerprint 确定派生——此前批次的候选事件同样能还原 itemKey→行 id 映射。
      outcome.itemKeyToCandidateId.set(itemKey, candidateIdOf(fingerprint));
    }
    // 本批内的 candidate/validation 立即可见（同事务先于 result 落库，顺序即 sequence 顺序）。
    for (const report of sortedBySequence(input.items)) {
      const parsed = parseContinuousReportV1Item(report.payload);
      if (!parsed.ok) {
        // 读侧 unknown 或载荷不符 V1：不丢行——拒绝事件原样记录（不据此 done/提交）。
        outcome.rejected.push({
          itemKey: report.itemKey,
          journalSequence: report.journalSequence,
          reason: parsed.reason,
        });
        items.push(rejectionEvent(input, report, now, parsed.reason));
        continue;
      }
      const item = parsed.item;
      switch (item.kind) {
        case "candidate": {
          fingerprintByItemKey.set(item.itemKey, item.fingerprint);
          outcome.itemKeyToCandidateId.set(item.itemKey, candidateIdOf(item.fingerprint));
          outcome.imported.candidates += 1;
          items.push({
            candidate: candidateOf(input, item, now),
            event: auditEvent(input, report, "report.candidate", item, now),
          });
          break;
        }
        case "decision": {
          outcome.imported.decisions += 1;
          items.push({
            decision: decisionOf(input, item, now),
            event: auditEvent(input, report, "report.decision", item, now),
          });
          break;
        }
        case "validation": {
          if (item.outcome === "passed") {
            const stages = passedStages.get(item.candidateKey) ?? new Set<string>();
            stages.add(item.stage);
            passedStages.set(item.candidateKey, stages);
          }
          outcome.imported.validations += 1;
          items.push({ event: auditEvent(input, report, "report.validation", item, now) });
          break;
        }
        case "candidate_result": {
          let doneAccepted = false;
          let gateReason: string | undefined;
          if (item.status === "done") {
            const stages = passedStages.get(item.candidateKey) ?? new Set<string>();
            const missing = REQUIRED_VALIDATION_STAGES.filter((stage) => !stages.has(stage));
            if (missing.length > 0) {
              gateReason = `done_without_full_validation: missing ${missing.join("+")}`;
            } else {
              doneAccepted = true;
            }
          }
          if (gateReason !== undefined) {
            outcome.rejected.push({
              itemKey: item.itemKey,
              journalSequence: report.journalSequence,
              reason: gateReason,
            });
            items.push(rejectionEvent(input, report, now, gateReason));
          }
          outcome.imported.candidateResults += 1;
          outcome.candidateResults.set(item.candidateKey, {
            item,
            doneAccepted,
            ...(gateReason === undefined ? {} : { gateReason }),
          });
          items.push({ event: auditEvent(input, report, "report.candidate_result", item, now) });
          break;
        }
        case "cycle_result": {
          outcome.imported.cycleResults += 1;
          outcome.cycleResult = item;
          items.push({ event: auditEvent(input, report, "report.cycle_result", item, now) });
          break;
        }
      }
    }

    // 决策→候选关联（复合 FK 保证同一 Program）：itemKey → fingerprint → 候选行。
    // 解析出的数据库 id 同时回填 Decision.blockingScope.candidateIds（§8 局部过滤的依据）。
    const decisionsByKey = new Map<string, Decision>();
    for (const entry of items) {
      if (entry.decision !== undefined)
        decisionsByKey.set(entry.decision.fingerprint, entry.decision);
    }
    for (const report of sortedBySequence(input.items)) {
      const parsed = parseContinuousReportV1Item(report.payload);
      if (!parsed.ok || parsed.item.kind !== "decision") continue;
      const decision = decisionsByKey.get(parsed.item.fingerprint);
      if (decision === undefined || decision.blockingScope === undefined) continue;
      for (const key of parsed.item.blockingScope.candidateKeys) {
        const fingerprint = fingerprintByItemKey.get(key);
        if (fingerprint === undefined) continue; // 未知 itemKey：关联跳过，Decision 本身照常入队
        const candidateId = candidateIdOf(fingerprint);
        const scope: Decision["blockingScope"] = decision.blockingScope;
        decision.blockingScope = {
          ...scope,
          paths: scope?.paths ?? [],
          candidateIds: [...(scope?.candidateIds ?? []), candidateId],
        };
        items.push({
          candidateDecisionLink: {
            programId: input.programId,
            candidateId,
            decisionId: decisionIdOf(parsed.item.fingerprint),
          },
        });
      }
    }

    if (items.length > 0) {
      await this.deps.repository.applyReportImport({
        programId: input.programId,
        cycleId: input.cycleId,
        items,
        nextCursor: input.nextCursor,
      });
    }
    return outcome;
  }
}

/** sequence 升序（journal 顺序即事实顺序；同批内 validation 先于其 candidate_result）。 */
function sortedBySequence(items: ContinuousReportItem[]): ContinuousReportItem[] {
  return [...items].sort((left, right) => left.journalSequence - right.journalSequence);
}

/** 已导入事件里的事实提取：passed 阶段表 + itemKey→fingerprint 映射。 */
function readPriorFact(
  event: ContinuousEvent,
  passedStages: Map<string, Set<string>>,
  fingerprintByItemKey: Map<string, string>,
): void {
  if (event.type === "report.validation") {
    const payload = event.payload as { candidateKey?: unknown; stage?: unknown; outcome?: unknown };
    if (
      payload?.candidateKey === undefined ||
      payload?.stage === undefined ||
      payload?.outcome !== "passed"
    ) {
      return;
    }
    const stages = passedStages.get(String(payload.candidateKey)) ?? new Set<string>();
    stages.add(String(payload.stage));
    passedStages.set(String(payload.candidateKey), stages);
    return;
  }
  if (event.type === "report.candidate") {
    const payload = event.payload as { itemKey?: unknown; fingerprint?: unknown };
    if (payload?.itemKey !== undefined && payload?.fingerprint !== undefined) {
      fingerprintByItemKey.set(String(payload.itemKey), String(payload.fingerprint));
    }
  }
}

function candidateOf(
  input: ReportBatchInput,
  item: ContinuousReportCandidateItem,
  now: number,
): Candidate {
  return {
    id: candidateIdOf(item.fingerprint),
    programId: input.programId,
    sourceCycleId: input.cycleId,
    fingerprint: item.fingerprint,
    title: item.title,
    rationale: item.rationale,
    targetPaths: item.targetPaths,
    impact: item.impact,
    confidence: item.confidence,
    effort: item.effort,
    risk: item.risk,
    status: "candidate",
    evidence: item.evidence,
    createdAt: now,
    updatedAt: now,
  };
}

/** 决策行 id：唯一派生在 domain/decisionPolicy（与 decisionService 的直读共用同一构造）。 */
const decisionIdOf = continuousDecisionRowId;

function decisionOf(
  input: ReportBatchInput,
  item: ContinuousReportDecisionItem,
  now: number,
): Decision {
  return {
    id: decisionIdOf(item.fingerprint),
    programId: input.programId,
    sourceCycleId: input.cycleId,
    fingerprint: item.fingerprint,
    version: 1,
    title: item.title,
    context: item.context,
    options: item.options,
    ...(item.recommendation === undefined ? {} : { recommendation: item.recommendation }),
    classification: item.classification,
    blockingScope: {
      candidateIds: [], // itemKey 关联在导入尾统一解析（candidateIds 是数据库 id 的集合）
      paths: item.blockingScope.paths,
      ...(item.blockingScope.capability === undefined
        ? {}
        : { capability: item.blockingScope.capability }),
    },
    status: "pending",
    // 首见来源（CT-06 合并语义）：重复发现经 saveDecision 的 merge 追加来源，不整行覆盖。
    sources: [{ cycleId: input.cycleId, discoveredAt: now, context: item.context }],
    createdAt: now,
    updatedAt: now,
  };
}

/** 审计事件：eventKey 携带 journal sequence（重放幂等；itemKey+sequence 是条目身份）。 */
function auditEvent(
  input: ReportBatchInput,
  report: ContinuousReportItem,
  type: string,
  payload: unknown,
  now: number,
): ContinuousEvent {
  return {
    programId: input.programId,
    cycleId: input.cycleId,
    eventKey: `report:${input.cycleId}:${report.journalSequence}`,
    type,
    payload,
    createdAt: now,
  };
}

function rejectionEvent(
  input: ReportBatchInput,
  report: ContinuousReportItem,
  now: number,
  reason: string,
): ReportImportItem {
  return {
    event: {
      programId: input.programId,
      cycleId: input.cycleId,
      eventKey: `report-rejected:${input.cycleId}:${report.journalSequence}`,
      type: "report.rejected",
      payload: { itemKey: report.itemKey, journalSequence: report.journalSequence, reason },
      createdAt: now,
    },
  };
}
