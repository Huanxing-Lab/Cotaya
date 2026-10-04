// Continuous 长期状态 sqlite 仓库（CT-01）：tasks-index 新表的唯一 SQL 写入方。
// 职责拆分：行编解码在 sqliteCodecs；连接/事务在 sqliteConnection；
// 队列/报告导入在 sqliteQueueStore；终态结算/租约在 sqliteLifecycleStore；
// 使用账本在 sqliteUsageStore。唯一性、同 Program 复合 FK、一个 Program 一条
// 未结束 Cycle 全部由数据库约束保证，不依赖内存锁（I-02/I-03）。

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { CONTINUOUS_OPEN_CYCLE_STATUSES } from "@zcode/shared";
import type {
  Candidate,
  ContinuousEvent,
  Cycle,
  Decision,
  Program,
  ProgramCompletionPatch,
  ReportImportInput,
  UsageRecord,
  UsageSettlementPatch,
  WorkspaceLease,
} from "../domain/types.js";
import type { ContinuousRepositoryPort } from "../application/ports.js";
import {
  decodeCycle,
  decodeProgram,
  encodeCycle,
  encodeProgram,
  type CycleRow,
  type ProgramRow,
} from "./sqliteCodecs.js";
import {
  openContinuousDatabase,
  inContinuousTransaction,
  insertRow,
  updateRowByKey,
  type ContinuousDatabaseSync,
} from "./sqliteConnection.js";
import {
  applyReportImportReady,
  appendEventReady,
  listPendingDecisionsReady,
  listQueueableCandidatesReady,
  saveCandidateReady,
  saveDecisionReady,
} from "./sqliteQueueStore.js";
import {
  acquireLeaseReady,
  completeCycleReady,
  getLeaseReady,
  releaseLeaseReady,
} from "./sqliteLifecycleStore.js";
import { insertUsageRecordReady, settleUsageRecordReady } from "./sqliteUsageStore.js";

export class SqliteContinuousRepository implements ContinuousRepositoryPort {
  private db: ContinuousDatabaseSync | null = null;
  private initializePromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly busyTimeoutMs = 5000,
  ) {}

  async ensureReady(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.initialize().catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    if (!this.db) this.db = openContinuousDatabase(this.dbPath, this.busyTimeoutMs);
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
    }
    this.db = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private database(): ContinuousDatabaseSync {
    if (!this.db) throw new Error("continuous sqlite 尚未初始化（先 await ensureReady()）");
    return this.db;
  }

  // ── Program ──

  async insertProgram(program: Program): Promise<void> {
    await this.ensureReady();
    insertRow(this.database(), "continuous_program", encodeProgram(program));
  }

  async getProgram(programId: string): Promise<Program | null> {
    await this.ensureReady();
    const row = this.database()
      .prepare("SELECT * FROM continuous_program WHERE id = ?")
      .get(programId);
    return row ? decodeProgram(row as unknown as ProgramRow) : null;
  }

  async saveProgram(program: Program): Promise<void> {
    await this.ensureReady();
    const db = this.database();
    inContinuousTransaction(db, () => {
      const stored = db
        .prepare("SELECT revision FROM continuous_program WHERE id = ?")
        .get(program.id) as { revision: number } | undefined;
      if (!stored)
        throw Object.assign(new Error(`continuous_program 不存在: ${program.id}`), {
          kind: "not_found",
        });
      // 乐观并发：已存 revision 领先于携带值说明另一写入者已前进，拒绝覆盖。
      if (stored.revision > program.revision)
        throw Object.assign(new Error(`program revision 冲突: ${program.id}`), {
          kind: "revision_conflict",
        });
      if (updateRowByKey(db, "continuous_program", encodeProgram(program), "id") !== 1)
        throw Object.assign(new Error(`continuous_program 不存在: ${program.id}`), {
          kind: "not_found",
        });
    });
  }

  async listPrograms(workspaceKey: string): Promise<Program[]> {
    await this.ensureReady();
    const rows = this.database()
      .prepare(
        "SELECT * FROM continuous_program WHERE workspace_key = ? AND archived_at IS NULL ORDER BY created_at",
      )
      .all(workspaceKey);
    return rows.map((row) => decodeProgram(row as unknown as ProgramRow));
  }

  // ── Cycle ──

  async insertCycle(cycle: Cycle): Promise<void> {
    await this.ensureReady();
    // 单条 INSERT 即原子：UNIQUE(program_id,sequence)/(program_id,trigger_key) 与
    // 部分唯一索引 continuous_one_open_cycle 在数据库层拒绝重复与第二个未结束 Cycle。
    insertRow(this.database(), "continuous_cycle", encodeCycle(cycle));
  }

  async saveCycle(cycle: Cycle): Promise<void> {
    await this.ensureReady();
    const db = this.database();
    inContinuousTransaction(db, () => {
      if (updateRowByKey(db, "continuous_cycle", encodeCycle(cycle), "id") !== 1)
        throw Object.assign(new Error(`continuous_cycle 不存在: ${cycle.id}`), {
          kind: "not_found",
        });
    });
  }

  async getCycle(cycleId: string): Promise<Cycle | null> {
    await this.ensureReady();
    const row = this.database().prepare("SELECT * FROM continuous_cycle WHERE id = ?").get(cycleId);
    return row ? decodeCycle(row as unknown as CycleRow) : null;
  }

  async getOpenCycle(programId: string): Promise<Cycle | null> {
    await this.ensureReady();
    const statuses = CONTINUOUS_OPEN_CYCLE_STATUSES as readonly string[];
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.database()
      .prepare(
        `SELECT * FROM continuous_cycle WHERE program_id = ? AND status IN (${placeholders})`,
      )
      .get(programId, ...statuses);
    return row ? decodeCycle(row as unknown as CycleRow) : null;
  }

  async getLatestCycleSequence(programId: string): Promise<number> {
    await this.ensureReady();
    const row = this.database()
      .prepare("SELECT MAX(sequence) AS latest FROM continuous_cycle WHERE program_id = ?")
      .get(programId) as { latest: number | null };
    return row.latest ?? 0;
  }

  // ── 队列与报告导入（sqliteQueueStore）──

  async saveCandidate(candidate: Candidate): Promise<void> {
    await this.ensureReady();
    saveCandidateReady(this.database(), candidate);
  }

  async listQueueableCandidates(programId: string): Promise<Candidate[]> {
    await this.ensureReady();
    return listQueueableCandidatesReady(this.database(), programId);
  }

  async saveDecision(decision: Decision): Promise<void> {
    await this.ensureReady();
    saveDecisionReady(this.database(), decision);
  }

  async listPendingDecisions(programId: string): Promise<Decision[]> {
    await this.ensureReady();
    return listPendingDecisionsReady(this.database(), programId);
  }

  async appendEvent(event: ContinuousEvent): Promise<void> {
    await this.ensureReady();
    appendEventReady(this.database(), event);
  }

  async applyReportImport(input: ReportImportInput): Promise<void> {
    await this.ensureReady();
    applyReportImportReady(this.database(), input);
  }

  // ── 终态结算与租约（sqliteLifecycleStore）──

  async completeCycle(cycle: Cycle, programPatch: ProgramCompletionPatch): Promise<void> {
    await this.ensureReady();
    completeCycleReady(this.database(), cycle, programPatch);
  }

  async getLease(workspaceKey: string): Promise<WorkspaceLease | null> {
    await this.ensureReady();
    return getLeaseReady(this.database(), workspaceKey);
  }

  async acquireLease(lease: WorkspaceLease): Promise<void> {
    await this.ensureReady();
    acquireLeaseReady(this.database(), lease);
  }

  async releaseLease(workspaceKey: string, updatedAt: number): Promise<void> {
    await this.ensureReady();
    releaseLeaseReady(this.database(), workspaceKey, updatedAt);
  }

  // ── 使用账本（sqliteUsageStore）──

  async insertUsageRecord(record: UsageRecord): Promise<void> {
    await this.ensureReady();
    insertUsageRecordReady(this.database(), record);
  }

  async settleUsageRecord(patch: UsageSettlementPatch): Promise<void> {
    await this.ensureReady();
    settleUsageRecordReady(this.database(), patch);
  }
}
