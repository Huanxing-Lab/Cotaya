// Continuous 报告协议（CT-05）：版本化 ContinuousReportV1 的载荷 schema（规格 §11）。
//
// 为什么独立成文件而不是并入 continuous-protocol.ts：那一份（capability/业务命令/快照/错误）
// 已到仓库 lint 的 max-lines 上限（CT-03 拆出执行面时同样的行数约束）；报告 V1 的消费者是
// 两端——bootstrap 的固定模板（产出侧，只依赖 @zcode/shared）与 services 的 reportIngestion
// （校验/导入侧）——放 shared 保证两侧共用同一份词汇表，不复制第二套（与 CT-04 预算协议同款
// 论证）。continuous-protocol.ts 以 `export *` 再导出，公开路径保持一个。
//
// 形状约定：模板经现有 report() 上送的每一条条目形如 { kind, itemKey, ...载荷 }；执行面读侧
// （CT-03 适配器）从载荷投影 kind/itemKey 并补 journalSequence，投不出 V1 形状的条目以
// kind "unknown" 原样上送（读侧不丢行、不编造类别）。本文件的 schema 只负责**导入侧**的
// 校验：kind/itemKey + 各 kind 的专属字段全部 strict，未知字段是协议变更，不允许静默透传。

import { z } from "zod";

const idString = z.string().min(1);

/** 条目去重键（模板侧自定义；同键不同 journalSequence 是两条事实，见 §11 itemKey 规则）。 */
const itemKeySchema = z.string().min(1).max(256);

/** 重复发现的语义去重键（UNIQUE(program_id, fingerprint) 的来源）。 */
const fingerprintSchema = z.string().min(8).max(256);

/** 验证证据：命令+退出码、浏览器断言/截图引用、review 结论等（模型不能只声称通过，规格 §7）。 */
export const continuousReportEvidenceSchema = z.strictObject({
  kind: z.string().min(1).max(64),
  detail: z.string().min(1).max(2048),
});
export type ContinuousReportEvidence = z.infer<typeof continuousReportEvidenceSchema>;

const evidenceListSchema = z.array(continuousReportEvidenceSchema).max(32);

// ── candidate：结构化候选与证据 ──────────────────────────────
export const continuousReportCandidateItemSchema = z.strictObject({
  kind: z.literal("candidate"),
  itemKey: itemKeySchema,
  fingerprint: fingerprintSchema,
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(4000),
  /** 候选授权路径（executionPath 相对，"/" 分隔）；至少一条。 */
  targetPaths: z.array(z.string().min(1).max(512)).min(1).max(50),
  impact: z.number().min(0).max(10),
  confidence: z.number().min(0).max(1),
  effort: z.number().min(0).max(10),
  risk: z.enum(["low", "medium", "high"]),
  evidence: evidenceListSchema,
});
export type ContinuousReportCandidateItem = z.infer<typeof continuousReportCandidateItemSchema>;

// ── decision：产品决策（blockingScope 只阻塞相关候选，规格 §8）────────────
export const continuousReportDecisionOptionSchema = z.strictObject({
  id: idString,
  label: z.string().min(1).max(200),
  consequences: z.string().min(1).max(2000),
});
export type ContinuousReportDecisionOption = z.infer<typeof continuousReportDecisionOptionSchema>;

export const continuousReportDecisionItemSchema = z.strictObject({
  kind: z.literal("decision"),
  itemKey: itemKeySchema,
  fingerprint: fingerprintSchema,
  title: z.string().min(1).max(200),
  context: z.string().min(1).max(4000),
  options: z.array(continuousReportDecisionOptionSchema).min(2).max(6),
  recommendation: idString.optional(),
  classification: z.enum(["deferred", "blocking"]),
  /**
   * 关联候选以**报告侧的 candidate itemKey**表达（模型不知道数据库 id）；
   * 导入侧负责 itemKey→Candidate 行的映射，见 reportIngestion。
   */
  blockingScope: z.strictObject({
    candidateKeys: z.array(itemKeySchema).max(50),
    paths: z.array(z.string().min(1).max(512)).max(50),
    capability: z.string().min(1).max(64).optional(),
  }),
});
export type ContinuousReportDecisionItem = z.infer<typeof continuousReportDecisionItemSchema>;

// ── validation：单候选单阶段的验证事实（测试/浏览器/独立 review）────────────
export const continuousReportValidationItemSchema = z
  .strictObject({
    kind: z.literal("validation"),
    itemKey: itemKeySchema,
    candidateKey: itemKeySchema,
    stage: z.enum(["tests", "browser", "review"]),
    outcome: z.enum(["passed", "failed", "unverified"]),
    evidence: evidenceListSchema,
    reason: z.string().min(1).max(2000).optional(),
  })
  .superRefine((item, ctx) => {
    // unverified/failed 必须说明原因（验证不可用要明确说出口，规格 §7「记录 unverified」）。
    if (item.outcome !== "passed" && item.reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: `${item.outcome} validation requires a reason`,
      });
    }
    // passed 必须附证据；无证据的“通过”只是模型自述（E-12「已通过文本不能覆盖事实」）。
    if (item.outcome === "passed" && item.evidence.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "passed validation requires evidence (command exit code, assertion, review note)",
      });
    }
  });
export type ContinuousReportValidationItem = z.infer<typeof continuousReportValidationItemSchema>;

// ── candidate_result：单候选终局（done 的门槛在导入侧复核，不信任自述）──────
export const continuousReportCandidateResultItemSchema = z
  .strictObject({
    kind: z.literal("candidate_result"),
    itemKey: itemKeySchema,
    candidateKey: itemKeySchema,
    status: z.enum(["done", "rejected", "unverified"]),
    changedFiles: z.array(z.string().min(1).max(512)).max(64),
    commits: z.array(z.string().regex(/^[0-9a-f]{7,40}$/)).max(16),
    summary: z.string().min(1).max(4000),
    reason: z.string().min(1).max(2000).optional(),
  })
  .superRefine((item, ctx) => {
    if (item.status === "done" && (item.commits.length === 0 || item.changedFiles.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["commits"],
        message: "done candidate_result requires at least one commit and changed file",
      });
    }
    if (item.status !== "done" && item.commits.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["commits"],
        message: "non-done candidate_result must not carry commits (nothing is committed)",
      });
    }
    if (item.status === "unverified" && item.reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "unverified candidate_result requires a reason",
      });
    }
  });
export type ContinuousReportCandidateResultItem = z.infer<
  typeof continuousReportCandidateResultItemSchema
>;

// ── cycle_result：整轮终局摘要（最终报告；导入侧仍按门复核 changedFiles/commits）──
export const continuousReportCycleResultItemSchema = z.strictObject({
  kind: z.literal("cycle_result"),
  itemKey: itemKeySchema,
  outcome: z.enum(["changes_verified", "no_changes", "partial"]),
  changedFiles: z.array(z.string().min(1).max(512)).max(256),
  commits: z.array(z.string().regex(/^[0-9a-f]{7,40}$/)).max(64),
  evidence: evidenceListSchema,
  summary: z.string().min(1).max(8000),
});
export type ContinuousReportCycleResultItem = z.infer<typeof continuousReportCycleResultItemSchema>;

// ── V1 条目全集（读侧 kind "unknown" 刻意不在词表内：它永远不会通过导入校验）──
export const continuousReportV1ItemSchema = z.discriminatedUnion("kind", [
  continuousReportCandidateItemSchema,
  continuousReportDecisionItemSchema,
  continuousReportValidationItemSchema,
  continuousReportCandidateResultItemSchema,
  continuousReportCycleResultItemSchema,
]);
export type ContinuousReportV1Item = z.infer<typeof continuousReportV1ItemSchema>;

/** 导入侧解析结果：成功带条目；失败带稳定 reason（写入拒绝事件，不据此 done/提交）。 */
export type ContinuousReportParseResult =
  | { ok: true; item: ContinuousReportV1Item }
  | { ok: false; reason: string };

/**
 * 解析一条报告载荷为 V1 条目。只做 schema 校验，不做 IO；调用方（reportIngestion）
 * 负责把失败写进拒绝事件（规格 §11「malformed report 记录拒绝事件」）。
 */
export function parseContinuousReportV1Item(payload: unknown): ContinuousReportParseResult {
  const parsed = continuousReportV1ItemSchema.safeParse(payload);
  if (parsed.success) return { ok: true, item: parsed.data };
  const first = parsed.error.issues[0];
  const path =
    first === undefined ? "" : first.path.length > 0 ? ` at ${first.path.join(".")}` : "";
  return {
    ok: false,
    reason:
      first === undefined ? "malformed report payload" : `${first.code}${path}: ${first.message}`,
  };
}
