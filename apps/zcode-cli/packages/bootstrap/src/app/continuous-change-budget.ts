// Continuous 单轮变更量预算（CT-02，规格 §2/§7）：累计文件数与改动行数按「相对单轮起始
// commit 的累计实际 diff」计算；删除、rename、binary 均计入文件数；rename 的旧/新路径
// 各占一个文件名额。纯函数，由执行层在每次写入前调用（U-03/E-14）。

export type ContinuousChangeKind = "create" | "modify" | "delete" | "rename" | "binary";

export interface ContinuousChangeRecord {
  /** repo 相对路径（executionPath 内，"/" 分隔）。 */
  path: string;
  /** rename 的原路径；与 path 各计一个文件名额。 */
  originalPath?: string;
  kind: ContinuousChangeKind;
  /** binary 记录行数按 0 计（内容由受保护路径规则另行拒绝），文件名额仍计入。 */
  added: number;
  removed: number;
}

export interface ContinuousChangeBudgetLimits {
  maxFiles: number;
  maxChangedLines: number;
}

export interface ContinuousChangeBudgetDecision {
  allowed: boolean;
  code: "allowed" | "file_limit" | "line_limit";
  projectedFiles: number;
  projectedChangedLines: number;
  limit: ContinuousChangeBudgetLimits;
}

/** 归一化路径集合：同一文件多次修改只占一个名额（累计口径）。 */
function collectPaths(records: readonly ContinuousChangeRecord[]): Set<string> {
  const paths = new Set<string>();
  for (const record of records) {
    paths.add(record.path);
    if (record.originalPath) {
      paths.add(record.originalPath);
    }
  }
  return paths;
}

function sumLines(records: readonly ContinuousChangeRecord[]): number {
  return records.reduce((total, record) => total + record.added + record.removed, 0);
}

/**
 * 在已应用的变更之上追加 proposed 变更，判断是否仍满足单轮上限。
 * 负数行数按 0 处理；上限判断使用追加后的累计投影值，不修改入参。
 */
export function checkContinuousChangeBudget(
  limits: ContinuousChangeBudgetLimits,
  applied: readonly ContinuousChangeRecord[],
  proposed: readonly ContinuousChangeRecord[],
): ContinuousChangeBudgetDecision {
  const projectedFiles = collectPaths([...applied, ...proposed]).size;
  const projectedChangedLines = sumLines(applied) + sumLines(proposed);
  if (projectedFiles > limits.maxFiles) {
    return {
      allowed: false,
      code: "file_limit",
      projectedFiles,
      projectedChangedLines,
      limit: limits,
    };
  }
  if (projectedChangedLines > limits.maxChangedLines) {
    return {
      allowed: false,
      code: "line_limit",
      projectedFiles,
      projectedChangedLines,
      limit: limits,
    };
  }
  return { allowed: true, code: "allowed", projectedFiles, projectedChangedLines, limit: limits };
}

/** 汇总已应用变更（供报告/UI 展示累计口径；不重复判定逻辑）。 */
export function summarizeContinuousChanges(applied: readonly ContinuousChangeRecord[]): {
  files: string[];
  changedLines: number;
} {
  return {
    files: [...collectPaths(applied)].sort(),
    changedLines: sumLines(applied),
  };
}
