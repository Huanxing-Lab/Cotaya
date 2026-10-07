// Continuous sqlite 行↔领域对象编解码（CT-01）。
// 规格 §5：JSON 字段必须经运行时 schema 校验，不能任意输入——
// 编码时校验后落库，解码时校验后还原；词表/策略 schema 复用 @zcode/shared，
// 不在本文件复制第二份状态集合。

import { z } from "zod";
import {
  continuousBudgetPolicySchema,
  continuousCadencePolicySchema,
  continuousDecisionPolicySchema,
  continuousScopePolicySchema,
} from "@zcode/shared";
import type {
  Candidate,
  ContinuousEvent,
  Cycle,
  CycleHealthState,
  Program,
  ProgramAuthorization,
} from "../domain/types.js";
import type {
  CandidateRow,
  CycleRow,
  DecisionRow,
  EventRow,
  ProgramRow,
} from "./sqliteRowTypes.js";

// ── JSON 字段 schema（运行时校验唯一来源）──

export const programConfigSchema = z.strictObject({
  goal: z.string().min(1),
  /** 创建时持久化的 IANA 时区（CT-04）：日窗口统计唯一基准；encode/decode 经 ...config 展开。 */
  timeZone: z.string().min(1),
  scope: continuousScopePolicySchema,
  budget: continuousBudgetPolicySchema,
  cadence: continuousCadencePolicySchema,
  decisionPolicy: continuousDecisionPolicySchema,
});
export type ProgramConfig = z.infer<typeof programConfigSchema>;

export const programAuthorizationSchema = z.strictObject({
  revision: z.number().int().positive(),
  templateHash: z.string().regex(/^[0-9a-f]{64}$/),
  grantedAt: z.string().min(1),
});

export const cycleTriggerSchema = z.strictObject({
  kind: z.enum(["manual", "interval", "daily", "decision_resolved"]),
});

export const cycleResultSchema = z.strictObject({
  outcome: z.enum(["changes_verified", "no_changes", "partial"]),
  changedFiles: z.array(z.string()),
  commits: z.array(z.string()),
  evidence: z.array(z.unknown()),
  summary: z.string(),
});

export const candidateBodySchema = z.strictObject({
  title: z.string().min(1),
  rationale: z.string(),
  targetPaths: z.array(z.string()),
  impact: z.number(),
  confidence: z.number(),
  effort: z.number(),
  risk: z.enum(["low", "medium", "high"]),
  evidence: z.array(z.unknown()),
});

export const decisionBodySchema = z.strictObject({
  title: z.string().min(1),
  context: z.string(),
  options: z.array(
    z.strictObject({ id: z.string().min(1), label: z.string(), consequences: z.string() }),
  ),
  recommendation: z.string().optional(),
  classification: z.enum(["deferred", "blocking"]),
  blockingScope: z
    .strictObject({
      candidateIds: z.array(z.string()),
      paths: z.array(z.string()),
      capability: z.string().optional(),
    })
    .optional(),
  /** 重复发现的来源清单（CT-06 合并语义；可选——首见行与旧协议无此字段）。 */
  sources: z
    .array(
      z.strictObject({
        cycleId: z.string().min(1),
        discoveredAt: z.number().int().nonnegative(),
        context: z.string().optional(),
        evidence: z.array(z.unknown()).optional(),
      }),
    )
    .optional(),
});

export const decisionResolutionSchema = z.strictObject({
  optionId: z.string().optional(),
  text: z.string().optional(),
  resolvedAt: z.number().int().nonnegative(),
});

// decision 行的编解码自 CT-06 起住在 sqliteDecisionStore.ts（本文件到顶，同 CT-04 把
// continuation 编解码移入对应 store 的先例）；schema 保留在此处供其导入。

// provider usage / 报告 payload 是自由 JSON 事实：校验边界是「可安全 JSON 往返」，
// 结构解释权在读取方（CT-04/CT-05）；undefined/函数等无法落库的值在此拒绝。
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type { ProgramRow, CycleRow, CandidateRow, DecisionRow, EventRow };

// ── 编解码（失败抛结构化 codec 错误，不把行内容写进错误消息）──

function codecError(field: string, cause: unknown): Error {
  return Object.assign(new Error(`continuous sqlite codec: ${field} 校验失败`), {
    kind: "continuous_codec_invalid",
    field,
    cause,
  });
}

/** JSON 字段编码（校验后序列化）；导出供同层 store 复用（CT-06 起 decision 编解码在 sqliteDecisionStore）。 */
export function encodeJson(field: string, schema: z.ZodType<unknown>, value: unknown): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw codecError(field, parsed.error);
  return JSON.stringify(parsed.data);
}

/** JSON 字段解码（解析+校验后还原）；导出供同层 store 复用。 */
export function decodeJson<T>(field: string, schema: z.ZodType<T>, raw: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw codecError(field, error);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw codecError(field, parsed.error);
  return parsed.data;
}

export function encodeProgram(program: Program): ProgramRow {
  const config = encodeJson("config_json", programConfigSchema, {
    goal: program.goal,
    timeZone: program.timeZone,
    scope: program.scope,
    budget: program.budget,
    cadence: program.cadence,
    decisionPolicy: program.decisionPolicy,
  });
  const authorization = encodeJson(
    "authorization_json",
    programAuthorizationSchema,
    program.authorization,
  );
  return {
    id: program.id,
    workspace_key: program.workspaceKey,
    workspace_path: program.workspacePath,
    workspace_identity: program.workspaceIdentity ?? null,
    remote_session_id: program.remoteSessionId ?? null,
    revision: program.revision,
    status: program.status,
    status_reason: program.statusReason ?? null,
    config_json: config,
    authorization_json: authorization,
    template_id: program.templateId,
    template_version: program.templateVersion,
    template_hash: program.templateHash,
    execution_path: program.executionPath ?? null,
    branch_name: program.branchName ?? null,
    next_cycle_at: program.nextCycleAt ?? null,
    last_cycle_at: program.lastCycleAt ?? null,
    consecutive_failures: program.consecutiveFailures,
    archived_at: program.archivedAt ?? null,
    created_at: program.createdAt,
    updated_at: program.updatedAt,
  };
}

export function decodeProgram(row: ProgramRow): Program {
  const config = decodeJson("config_json", programConfigSchema, row.config_json);
  const authorization: ProgramAuthorization = decodeJson(
    "authorization_json",
    programAuthorizationSchema,
    row.authorization_json,
  );
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    remoteSessionId: row.remote_session_id ?? undefined,
    revision: row.revision,
    ...config,
    authorization,
    templateId: row.template_id,
    templateVersion: row.template_version,
    templateHash: row.template_hash,
    executionPath: row.execution_path ?? undefined,
    branchName: row.branch_name ?? undefined,
    status: row.status as Program["status"],
    statusReason: row.status_reason ?? undefined,
    nextCycleAt: row.next_cycle_at ?? undefined,
    lastCycleAt: row.last_cycle_at ?? undefined,
    consecutiveFailures: row.consecutive_failures,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function encodeCycle(cycle: Cycle): CycleRow {
  return {
    id: cycle.id,
    program_id: cycle.programId,
    sequence: cycle.sequence,
    trigger_key: cycle.triggerKey,
    trigger_json: encodeJson("trigger_json", cycleTriggerSchema, cycle.trigger),
    status: cycle.status,
    config_snapshot_json: encodeJson(
      "config_snapshot_json",
      jsonValueSchema,
      cycle.configurationSnapshot,
    ),
    script_text: cycle.scriptText,
    script_hash: cycle.scriptHash,
    execution_session_id: cycle.executionSessionId,
    workflow_run_id: cycle.workflowRunId,
    trace_id: cycle.traceId,
    lease_epoch: cycle.leaseEpoch,
    resume_attempts: cycle.resumeAttempts,
    active_duration_ms: cycle.activeDurationMs,
    normal_blocked_duration_ms: cycle.normalBlockedDurationMs,
    health_state: cycle.healthState,
    last_progress_at: cycle.lastProgressAt ?? null,
    last_probe_at: cycle.lastProbeAt ?? null,
    pending_continuation_request_id: cycle.pendingContinuationRequestId ?? null,
    report_cursor: cycle.reportCursor,
    base_commit: cycle.baseCommit ?? null,
    result_json: cycle.result ? encodeJson("result_json", cycleResultSchema, cycle.result) : null,
    started_at: cycle.startedAt ?? null,
    completed_at: cycle.completedAt ?? null,
    created_at: cycle.createdAt,
    updated_at: cycle.updatedAt,
  };
}

export function decodeCycle(row: CycleRow): Cycle {
  return {
    id: row.id,
    programId: row.program_id,
    sequence: row.sequence,
    triggerKey: row.trigger_key,
    trigger: decodeJson("trigger_json", cycleTriggerSchema, row.trigger_json),
    status: row.status as Cycle["status"],
    configurationSnapshot: decodeJson(
      "config_snapshot_json",
      jsonValueSchema,
      row.config_snapshot_json,
    ),
    scriptText: row.script_text,
    scriptHash: row.script_hash,
    executionSessionId: row.execution_session_id,
    workflowRunId: row.workflow_run_id,
    traceId: row.trace_id,
    leaseEpoch: row.lease_epoch,
    resumeAttempts: row.resume_attempts,
    activeDurationMs: row.active_duration_ms,
    normalBlockedDurationMs: row.normal_blocked_duration_ms,
    healthState: row.health_state as CycleHealthState,
    lastProgressAt: row.last_progress_at ?? undefined,
    lastProbeAt: row.last_probe_at ?? undefined,
    pendingContinuationRequestId: row.pending_continuation_request_id ?? undefined,
    reportCursor: row.report_cursor,
    baseCommit: row.base_commit ?? undefined,
    result: row.result_json
      ? decodeJson("result_json", cycleResultSchema, row.result_json)
      : undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function encodeCandidate(candidate: Candidate): CandidateRow {
  return {
    id: candidate.id,
    program_id: candidate.programId,
    source_cycle_id: candidate.sourceCycleId,
    fingerprint: candidate.fingerprint,
    status: candidate.status,
    body_json: encodeJson("body_json", candidateBodySchema, {
      title: candidate.title,
      rationale: candidate.rationale,
      targetPaths: candidate.targetPaths,
      impact: candidate.impact,
      confidence: candidate.confidence,
      effort: candidate.effort,
      risk: candidate.risk,
      evidence: candidate.evidence,
    }),
    execution_cycle_id: candidate.executionCycleId ?? null,
    created_at: candidate.createdAt,
    updated_at: candidate.updatedAt,
  };
}

export function decodeCandidate(row: CandidateRow): Candidate {
  const body = decodeJson("body_json", candidateBodySchema, row.body_json);
  return {
    id: row.id,
    programId: row.program_id,
    sourceCycleId: row.source_cycle_id,
    fingerprint: row.fingerprint,
    ...body,
    status: row.status as Candidate["status"],
    executionCycleId: row.execution_cycle_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function encodeEvent(event: ContinuousEvent): Omit<EventRow, "id"> {
  return {
    program_id: event.programId,
    cycle_id: event.cycleId ?? null,
    event_key: event.eventKey,
    type: event.type,
    payload_json: encodeJson("payload_json", jsonValueSchema, event.payload),
    created_at: event.createdAt,
  };
}

export function decodeEvent(row: EventRow): ContinuousEvent {
  return {
    id: row.id,
    programId: row.program_id,
    cycleId: row.cycle_id ?? undefined,
    eventKey: row.event_key,
    type: row.type,
    payload: decodeJson("payload_json", jsonValueSchema, row.payload_json),
    createdAt: row.created_at,
  };
}

// 自由 JSON 字段的受控入口：usage/报告 payload 等由使用方持字段名调用，
// 校验语义仍是「可安全 JSON 往返」（见 jsonValueSchema 注释）。
export function encodeJsonValue(field: string, value: unknown): string {
  return encodeJson(field, jsonValueSchema, value);
}

export function decodeJsonValue(field: string, raw: string): unknown {
  return decodeJson(field, jsonValueSchema, raw);
}
