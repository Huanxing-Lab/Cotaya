// Continuous sqlite 连接与事务原语（CT-01）。
// 独立成文件避免 repository 与各 store 之间出现循环依赖（AGENTS 禁止）。

import { createRequire } from "node:module";
import type { SQLInputValue } from "node:sqlite";

// 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export type ContinuousDatabaseSync = InstanceType<typeof DatabaseSync>;

/** 打开业务连接：与 tasks-index 既有 Repo 相同的 PRAGMA 组合；FK 强制开启。 */
export function openContinuousDatabase(
  path: string,
  busyTimeoutMs: number,
): ContinuousDatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/** 库级串行写事务：失败整体回滚，不产生半条队列（规格 §5 事务边界）。 */
export function inContinuousTransaction<T>(db: ContinuousDatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      /* 回滚失败不能覆盖首因；调用方关闭连接恢复。 */
    }
    throw error;
  }
}

/** SQLite 约束类错误（UNIQUE/FK/CHECK 均为 SQLITE_CONSTRAINT 家族，errcode 低 8 位为 19）。 */
export function isSqliteConstraintError(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return typeof code === "number" && (code & 0xff) === 19;
}

// 表名/列名来自代码常量而非外部输入；值一律走绑定参数。
// codecs 的行值只含 string|number|null，统一绑定到 SQLInputValue。

export function insertRow(db: ContinuousDatabaseSync, table: string, row: object): void {
  const columns = Object.keys(row);
  const values = Object.values(row) as SQLInputValue[];
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...values);
}

export function updateRowByKey(
  db: ContinuousDatabaseSync,
  table: string,
  row: object,
  keyColumn: string,
): number {
  const columns = Object.keys(row).filter((column) => column !== keyColumn);
  const values = columns.map((column) => row[column as keyof typeof row]) as SQLInputValue[];
  const result = db
    .prepare(
      `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")}
       WHERE ${keyColumn} = ?`,
    )
    .run(...values, row[keyColumn as keyof typeof row] as SQLInputValue);
  return Number(result.changes);
}
