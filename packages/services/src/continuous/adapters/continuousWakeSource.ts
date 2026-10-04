// Continuous 到期唤醒的只读查询面（CT-07；规格 §10 wake 链路）。
//
// 供桌面 scheduler 进程使用：查询到期（next_cycle_at 已过、active/sleeping、未归档）的
// Continuous Program，交 scheduler 发 wake。刻意只读——scheduler 只查询和唤醒，不创建
// Cycle、不写队列、不保存任何派发状态（与 automation 的 claim/派发即释放锁不同；
// 重复 wake 由 Host 侧 trigger key UNIQUE 与「一个 Program 一条未结束 Cycle」约束幂等吸收）。
//
// 连接模式仿 AutomationRepo（自有连接 + ensureReady），但刻意不触碰 session 模块的
// migration 入口：tasks-index 的建库/迁移属 Host/storage worker 职责；本查询面对缺表
// （旧库未升级）返回空列表——功能未启用时 scheduler 自然无 wake 可发。

import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { getTasksIndexDatabasePath } from "#src/paths.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/** 到期 Program 的最小唤醒载荷（身份字段按 workspace identity 规则原样传递）。 */
export interface ContinuousDueProgram {
  programId: string;
  /** 持久化的到期时刻（trigger key 的组成部分；错过多轮时不改写）。 */
  nextCycleAt: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export class ContinuousWakeSource {
  private db: InstanceType<typeof DatabaseSync> | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) this.close();
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error: unknown) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // 忽略：关闭路径尽力而为。
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
  }

  /** 到期查询（只读）：due = next_cycle_at <= now 且 status ∈ {active, sleeping} 且未归档。 */
  async listDue(now: number): Promise<ContinuousDueProgram[]> {
    await this.ensureReady();
    const tableExists = this.db!.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'continuous_program'",
    ).get();
    if (tableExists === undefined) return [];
    const rows = this.db!.prepare(
      `SELECT id, next_cycle_at, workspace_key, workspace_path, workspace_identity, remote_session_id
         FROM continuous_program
         WHERE archived_at IS NULL
           AND status IN ('active', 'sleeping')
           AND next_cycle_at IS NOT NULL
           AND next_cycle_at <= ?`,
    ).all(now) as Array<{
      id: string;
      next_cycle_at: number;
      workspace_key: string;
      workspace_path: string;
      workspace_identity: string | null;
      remote_session_id: string | null;
    }>;
    return rows.map((row) => ({
      programId: row.id,
      nextCycleAt: row.next_cycle_at,
      workspaceKey: row.workspace_key,
      workspacePath: row.workspace_path,
      ...(row.workspace_identity === null ? {} : { workspaceIdentity: row.workspace_identity }),
      ...(row.remote_session_id === null ? {} : { remoteSessionId: row.remote_session_id }),
    }));
  }
}
