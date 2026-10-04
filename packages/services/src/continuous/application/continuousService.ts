// ContinuousService（CT-01）：长期状态的唯一业务写入口，本 ticket 先接 CRUD。
// 规格 §4/§5：所有写路径经过这里再落 Repository；UI/协议命令层（CT-05+）在
// capability 校验后调用本服务。原子性不靠本层内存锁——去重、一个 Program 一条
// 未结束 Cycle、同 Program 归属全部由数据库约束兜底，本层只做前置检查与组装。
// 时间唯一来源是注入的 Clock（测试可控），不在业务层直接读系统时钟。

import { randomUUID } from "node:crypto";
import { resolveWorkspaceKey } from "@zcode/shared";
import { isTerminalCycleStatus } from "../domain/types.js";
import type {
  Candidate,
  ContinuousEvent,
  Cycle,
  CycleTrigger,
  Decision,
  Program,
  ProgramCompletionPatch,
  ReportImportInput,
  UsageRecord,
  UsageSettlementPatch,
  WorkspaceLease,
} from "../domain/types.js";
import type { ContinuousClockPort, ContinuousRepositoryPort } from "./ports.js";

export interface ContinuousServiceDeps {
  repository: ContinuousRepositoryPort;
  clock: Pick<ContinuousClockPort, "now">;
}

export interface CreateProgramInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  goal: string;
  scope: Program["scope"];
  budget: Program["budget"];
  cadence: Program["cadence"];
  decisionPolicy: Program["decisionPolicy"];
  templateId: string;
  templateVersion: string;
  templateHash: string;
  authorization: Program["authorization"];
}

export interface CreateCycleInput {
  programId: string;
  /** 幂等键：manual 用请求 ID；scheduled 用 Program/revision/到期时间（§10）。 */
  triggerKey: string;
  trigger: CycleTrigger;
  scriptText: string;
  scriptHash: string;
  executionSessionId: string;
  workflowRunId: string;
  traceId: string;
  configurationSnapshot: unknown;
  baseCommit?: string;
}

export class ContinuousService {
  constructor(private readonly deps: ContinuousServiceDeps) {}

  // ── Program CRUD ──

  async createProgram(input: CreateProgramInput): Promise<Program> {
    const now = this.deps.clock.now();
    const program: Program = {
      id: randomUUID(),
      // 身份 key 统一走共享构造器：workspaceIdentity?.trim() || workspacePath。
      workspaceKey: resolveWorkspaceKey({
        workspacePath: input.workspacePath,
        workspaceIdentity: input.workspaceIdentity,
      }),
      workspacePath: input.workspacePath,
      workspaceIdentity: input.workspaceIdentity,
      remoteSessionId: input.remoteSessionId,
      revision: 1,
      goal: input.goal,
      scope: input.scope,
      budget: input.budget,
      cadence: input.cadence,
      decisionPolicy: input.decisionPolicy,
      authorization: input.authorization,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      templateHash: input.templateHash,
      status: "active",
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repository.insertProgram(program);
    return program;
  }

  async getProgram(programId: string): Promise<Program | null> {
    return this.deps.repository.getProgram(programId);
  }

  async saveProgram(program: Program): Promise<void> {
    await this.deps.repository.saveProgram(program);
  }

  async listPrograms(workspaceKey: string): Promise<Program[]> {
    return this.deps.repository.listPrograms(workspaceKey);
  }

  // ── Cycle ──

  async createCycle(input: CreateCycleInput): Promise<Cycle> {
    const program = await this.deps.repository.getProgram(input.programId);
    if (!program)
      throw Object.assign(new Error(`program 不存在: ${input.programId}`), {
        kind: "not_found",
      });
    const open = await this.deps.repository.getOpenCycle(input.programId);
    if (open)
      throw Object.assign(new Error(`program 已有未结束 cycle: ${input.programId}/${open.id}`), {
        kind: "open_cycle_exists",
      });
    const now = this.deps.clock.now();
    const sequence = (await this.deps.repository.getLatestCycleSequence(input.programId)) + 1;
    const cycle: Cycle = {
      id: randomUUID(),
      programId: input.programId,
      sequence,
      triggerKey: input.triggerKey,
      trigger: input.trigger,
      status: "preparing",
      configurationSnapshot: input.configurationSnapshot,
      scriptText: input.scriptText,
      scriptHash: input.scriptHash,
      executionSessionId: input.executionSessionId,
      workflowRunId: input.workflowRunId,
      traceId: input.traceId,
      leaseEpoch: 0,
      resumeAttempts: 0,
      activeDurationMs: 0,
      normalBlockedDurationMs: 0,
      healthState: "progressing",
      reportCursor: 0,
      baseCommit: input.baseCommit,
      createdAt: now,
      updatedAt: now,
    };
    // 并发窗口内另一写入者先落库时，UNIQUE(trigger_key)/部分唯一索引在数据库层拒绝。
    await this.deps.repository.insertCycle(cycle);
    return cycle;
  }

  async getCycle(cycleId: string): Promise<Cycle | null> {
    return this.deps.repository.getCycle(cycleId);
  }

  async getOpenCycle(programId: string): Promise<Cycle | null> {
    return this.deps.repository.getOpenCycle(programId);
  }

  async saveCycle(cycle: Cycle): Promise<void> {
    await this.deps.repository.saveCycle(cycle);
  }

  /** 终态 Cycle 与 Program 调度字段同事务提交；只接受终态（I-03/R-08 前置）。 */
  async completeCycle(cycle: Cycle, patch: ProgramCompletionPatch): Promise<void> {
    if (!isTerminalCycleStatus(cycle.status))
      throw Object.assign(new Error(`cycle 尚未终态: ${cycle.id}`), {
        kind: "cycle_not_terminal",
      });
    await this.deps.repository.completeCycle(cycle, patch);
  }

  // ── 队列 / 事件 / 报告导入 ──

  async saveCandidate(candidate: Candidate): Promise<void> {
    await this.deps.repository.saveCandidate(candidate);
  }

  async listQueueableCandidates(programId: string): Promise<Candidate[]> {
    return this.deps.repository.listQueueableCandidates(programId);
  }

  async saveDecision(decision: Decision): Promise<void> {
    await this.deps.repository.saveDecision(decision);
  }

  async listPendingDecisions(programId: string): Promise<Decision[]> {
    return this.deps.repository.listPendingDecisions(programId);
  }

  async appendEvent(event: ContinuousEvent): Promise<void> {
    await this.deps.repository.appendEvent(event);
  }

  async importReport(input: ReportImportInput): Promise<void> {
    await this.deps.repository.applyReportImport(input);
  }

  // ── workspace 执行占用 ──

  async getLease(workspaceKey: string): Promise<WorkspaceLease | null> {
    return this.deps.repository.getLease(workspaceKey);
  }

  async acquireLease(lease: WorkspaceLease): Promise<void> {
    await this.deps.repository.acquireLease(lease);
  }

  async releaseLease(workspaceKey: string, updatedAt?: number): Promise<void> {
    await this.deps.repository.releaseLease(workspaceKey, updatedAt ?? this.deps.clock.now());
  }

  // ── 使用账本（CT-04 在此之上建 admission）──

  async recordUsage(record: UsageRecord): Promise<void> {
    await this.deps.repository.insertUsageRecord(record);
  }

  async settleUsage(patch: UsageSettlementPatch): Promise<void> {
    await this.deps.repository.settleUsageRecord(patch);
  }
}
