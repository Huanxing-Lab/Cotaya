// Continuous 行 id 派生（CT-06）：application 层的单一实现。
//
// 决策行 id 由 fingerprint 确定派生（UNIQUE(program_id,fingerprint) 的稳定主键）。
// 报告导入侧（reportIngestion）与执行中持久化侧（decisionService）必须产出同一 id——
// 后者按 fingerprint 派生 id 直读全状态行（含已 resolved/dismissed）。两处各写一份
// sha256 截断迟早漂移，因此收敛在此；不住在 domain/ 是因为 domain 层禁止依赖 IO 模块
// （node:crypto 属于架构检查的 domain-io 禁用面，同舍入/时区等策略函数的纯度边界）。

import { createHash } from "node:crypto";

export function continuousDecisionRowId(fingerprint: string): string {
  return `dec:${createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 24)}`;
}
