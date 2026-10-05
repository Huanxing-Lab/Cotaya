// ============================================================
// Continuous 工具端口证据登记（CT-11 第 4 条）
// ============================================================
// 修复依据：docs/tickets/continuous-release-gaps.md CT-11 第 4 条——「测试退出码、输出、
// Git diff、文件/行数和浏览器 390/1280 证据由工具端口产生并关联 candidate/run/epoch。
// 模型返回 exitCode: 0 或 passed 只算报告，不能授权提交」。
//
// 本登记册是 CLI 进程内「工具端口产出的验证事实」唯一所有者：只有可信端口
// （continuous-trusted-ports）能写入 producedBy=confined-test / git-port / browser-port /
// commit-port 的记录；reviewer 的结论单独标 producedBy=review-report（它本质是模型
// 判断，作为否决面参与门语义，但不单独构成授权）。提交门（commitGate）只采信工具端口
// 事实——这是「模型报告不能授权提交」的执行点。
//
// 门语义与 services 侧 reportIngestion 的 done 门一致：**每阶段取最新结果**（先过再败
// 仍然拒绝），三阶段（tests/browser/review）+ diff 归属全过才放行提交。

import type { ContinuousConfinedRunResult } from "./continuous-confined-execution.js";
import { continuousPathPrefixCovers } from "./continuous-trusted-git.js";

export type ContinuousEvidenceStage = "tests" | "browser" | "review" | "diff" | "commit";

export type ContinuousEvidenceProducer =
  | "confined-test"
  | "git-port"
  | "browser-port"
  | "review-report"
  | "commit-port";

export interface ContinuousEvidenceRef {
  runId: string;
  cycleId: string;
  /** 记录产生时的执行权版本（旧 epoch 的迟到证据不参与门判定）。 */
  epoch: number;
  candidateKey: string;
}

interface EvidenceRecordBase extends ContinuousEvidenceRef {
  stage: ContinuousEvidenceStage;
  producedBy: ContinuousEvidenceProducer;
  recordedAt: number;
  sequence: number;
}

export interface ContinuousTestEvidence extends EvidenceRecordBase {
  stage: "tests";
  producedBy: "confined-test";
  argv: string[];
  exitCode: number | null;
  status: ContinuousConfinedRunResult["status"];
  stdoutPath: string;
  stderrPath: string;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
  isolationKey: string;
}

export interface ContinuousBrowserEvidence extends EvidenceRecordBase {
  stage: "browser";
  producedBy: "browser-port";
  outcome: "passed" | "failed" | "unverified";
  widths: number[];
  assertions: Array<{ kind: string; detail: string }>;
  reason: string;
  /** 截图/报告的受控落点（提供方给出；无则空数组——不伪造证据）。 */
  artifacts: string[];
}

export interface ContinuousReviewEvidence extends EvidenceRecordBase {
  stage: "review";
  producedBy: "review-report";
  outcome: "passed" | "failed";
  findings: string[];
}

export interface ContinuousDiffEvidence extends EvidenceRecordBase {
  stage: "diff";
  producedBy: "git-port";
  /** 工作区相对、"/" 分隔。 */
  changedFiles: string[];
  added: number;
  removed: number;
  /** 相对单轮起始 commit 的累计口径（规格 §2）。 */
  cumulative: { files: number; changedLines: number };
}

export interface ContinuousCommitEvidence extends EvidenceRecordBase {
  stage: "commit";
  producedBy: "commit-port";
  commit: string;
  changedFiles: string[];
}

export type ContinuousEvidenceRecord =
  | ContinuousTestEvidence
  | ContinuousBrowserEvidence
  | ContinuousReviewEvidence
  | ContinuousDiffEvidence
  | ContinuousCommitEvidence;

export type ContinuousCommitGateDecision =
  | {
      ok: true;
      tests: ContinuousTestEvidence;
      browser: ContinuousBrowserEvidence;
      review: ContinuousReviewEvidence;
      diff: ContinuousDiffEvidence;
    }
  | {
      ok: false;
      reason:
        | "tests_missing"
        | "tests_failed"
        | "browser_missing"
        | "browser_not_passed"
        | "review_missing"
        | "review_failed"
        | "diff_missing"
        | "diff_out_of_candidate";
    };

export interface ContinuousEvidenceRegistry {
  recordTest(
    input: Omit<ContinuousTestEvidence, "stage" | "producedBy" | "recordedAt" | "sequence">,
  ): void;
  recordBrowser(
    input: Omit<ContinuousBrowserEvidence, "stage" | "producedBy" | "recordedAt" | "sequence">,
  ): void;
  recordReview(
    input: Omit<ContinuousReviewEvidence, "stage" | "producedBy" | "recordedAt" | "sequence">,
  ): void;
  recordDiff(
    input: Omit<ContinuousDiffEvidence, "stage" | "producedBy" | "recordedAt" | "sequence">,
  ): void;
  recordCommit(
    input: Omit<ContinuousCommitEvidence, "stage" | "producedBy" | "recordedAt" | "sequence">,
  ): void;
  latest(
    candidateKey: string,
    stage: ContinuousEvidenceStage,
  ): ContinuousEvidenceRecord | undefined;
  /** 提交门：只采信工具端口证据；三阶段 + diff 归属全过才 ok。 */
  commitGate(
    candidateKey: string,
    epoch: number,
    candidatePaths: string[],
  ): ContinuousCommitGateDecision;
}

/** epoch 一致性：迟到的旧 epoch 证据不参与门（防旧执行覆盖新轮事实）。 */
function latestAtEpoch(
  registry: ContinuousEvidenceRecord[],
  candidateKey: string,
  stage: ContinuousEvidenceStage,
  epoch: number,
): ContinuousEvidenceRecord | undefined {
  let latestRecord: ContinuousEvidenceRecord | undefined;
  for (const record of registry) {
    if (record.candidateKey !== candidateKey || record.stage !== stage) continue;
    if (latestRecord === undefined || record.sequence > latestRecord.sequence)
      latestRecord = record;
  }
  return latestRecord !== undefined && latestRecord.epoch === epoch ? latestRecord : undefined;
}

export function createContinuousEvidenceRegistry(): ContinuousEvidenceRegistry {
  const records: ContinuousEvidenceRecord[] = [];
  let sequence = 0;
  const append = (record: Omit<ContinuousEvidenceRecord, "recordedAt" | "sequence">): void => {
    sequence += 1;
    records.push({ ...record, recordedAt: Date.now(), sequence } as ContinuousEvidenceRecord);
  };
  const latestOf = (candidateKey: string, stage: ContinuousEvidenceStage) => {
    let latestRecord: ContinuousEvidenceRecord | undefined;
    for (const record of records) {
      if (record.candidateKey !== candidateKey || record.stage !== stage) continue;
      if (latestRecord === undefined || record.sequence > latestRecord.sequence)
        latestRecord = record;
    }
    return latestRecord;
  };
  return {
    recordTest: (input) => append({ ...input, stage: "tests", producedBy: "confined-test" }),
    recordBrowser: (input) => append({ ...input, stage: "browser", producedBy: "browser-port" }),
    recordReview: (input) => append({ ...input, stage: "review", producedBy: "review-report" }),
    recordDiff: (input) => append({ ...input, stage: "diff", producedBy: "git-port" }),
    recordCommit: (input) => append({ ...input, stage: "commit", producedBy: "commit-port" }),
    latest: latestOf,
    commitGate(candidateKey, epoch, candidatePaths) {
      const tests = latestAtEpoch(records, candidateKey, "tests", epoch);
      if (tests === undefined) return { ok: false, reason: "tests_missing" };
      if (tests.producedBy !== "confined-test") return { ok: false, reason: "tests_missing" };
      if (tests.status !== "completed" || tests.exitCode !== 0)
        return { ok: false, reason: "tests_failed" };
      const browser = latestAtEpoch(records, candidateKey, "browser", epoch);
      if (browser === undefined || browser.producedBy !== "browser-port") {
        return { ok: false, reason: "browser_missing" };
      }
      if ((browser as ContinuousBrowserEvidence).outcome !== "passed") {
        return { ok: false, reason: "browser_not_passed" };
      }
      const review = latestAtEpoch(records, candidateKey, "review", epoch);
      if (review === undefined || review.producedBy !== "review-report") {
        return { ok: false, reason: "review_missing" };
      }
      if ((review as ContinuousReviewEvidence).outcome !== "passed") {
        return { ok: false, reason: "review_failed" };
      }
      const diff = latestAtEpoch(records, candidateKey, "diff", epoch);
      if (diff === undefined || diff.producedBy !== "git-port")
        return { ok: false, reason: "diff_missing" };
      // 提交前复查实际改动路径：全部落在当前候选授权路径内（规格 §7「限制只改当前
      // 授权路径」；越界改动既不提交也不清理——保留现场并拒绝）。段前缀判定与
      // trusted 提交侧共用 continuousPathPrefixCovers（单一实现）。
      const outside = diff.changedFiles.filter(
        (file) => !candidatePaths.some((prefix) => continuousPathPrefixCovers(prefix, file)),
      );
      if (outside.length > 0) return { ok: false, reason: "diff_out_of_candidate" };
      return {
        ok: true,
        tests: tests as ContinuousTestEvidence,
        browser: browser as ContinuousBrowserEvidence,
        review: review as ContinuousReviewEvidence,
        diff: diff as ContinuousDiffEvidence,
      };
    },
  };
}
