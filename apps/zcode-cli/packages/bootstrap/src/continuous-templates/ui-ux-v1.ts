// ============================================================
// Continuous 固定模板 ui-ux-v1（CT-05，规格 §7 固定版本骨架）
// ============================================================
// 版本化产品模板：观察/批评（只读）→ 结构化候选与证据 → 服务分类与依赖检查 → 选择最多
// N 项自主候选 → 单 builder 逐项实施 → 可执行测试 → 浏览器/视觉验证 → 只读独立 Review →
// 每项本地提交 → 最终报告。
//
// 硬约束（docs/tickets/continuous.md CT-05）：
// - 只用现有 facade 能力：typed ask（接口声明 + ask<T>）、report()、artifact/world.run/git.*
//   读取；不扩 compiler/lowering（本脚本是普通 Dynamic Workflow 脚本，经同一编译器编译）。
// - 不覆盖用户 saved workflow：模板只经本文件注册表暴露，Host（CT-05+ 装配）以
//   templateId@version + hash 绑定 Program 授权；saved-workflows store 完全不涉。
// - 不跨 Cycle imported cache：每个 Cycle 都是新 submitOnce（非 amend），命名 actor 的
//   imported cache 只在 amend-resume 内生效，天然不跨 Cycle；新 Cycle 的 actor 会话 id 由
//   runId 派生（mintActorSessionId），新 runId → 全新 actor 身份（I-09「新轮 actor ID 不复用」）。
// - Continuous parent 不并行 Goal continuation：parent 会话只是执行身份锚点，本模板的全部
//   模型工作都在子 actor 会话内（引擎只为 actor 建 runtime）；parent 从不开 turn/goal loop。
//
// 报告词表：每条 report() 载荷是 ContinuousReportV1（@zcode/shared continuous-report-protocol）
// 的一种条目 { kind, itemKey, ...载荷 }；导入侧（services reportIngestion）schema 校验后
// 事务导入，done 只有三阶段验证（tests/browser/review）全 passed 才被采信——本模板在脚本层
// 同样只在三者全过时才提交与上报 done（模型生成、代码把关）。

import { createHash } from "node:crypto";
import { CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT } from "./ui-ux-v1-script.js";

/** 模板身份（Program.templateId/templateVersion 的 v1 值）。 */
export const CONTINUOUS_TEMPLATE_UI_UX_V1_ID = "ui-ux-v1";
export const CONTINUOUS_TEMPLATE_UI_UX_V1_VERSION = "1";

/**
 * 模板脚本文本（实现在 ./ui-ux-v1-script.ts——架构 max-file-lines 拆分，非边界变化）。
 * 刻意只用字符串拼接（无内嵌模板字面量）；编译检查在 template.test.ts 用真实编译器钉住
 * （编译失败 = 模板不可用 = 明确失败，不静默换脚本，规格 §6）。
 */
export { CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT };

/** 版本化模板定义（Host 的 templateSource 注册表条目）。 */
export interface ContinuousTemplateDefinition {
  templateId: string;
  templateVersion: string;
  scriptText: string;
  /** scriptText 的 sha256 hex；授权绑定与 resume 防漂移都用它。 */
  scriptHash: string;
}

function defineTemplate(
  templateId: string,
  templateVersion: string,
  scriptText: string,
): ContinuousTemplateDefinition {
  return {
    templateId,
    templateVersion,
    scriptText,
    scriptHash: createHash("sha256").update(scriptText, "utf8").digest("hex"),
  };
}

/** ui-ux-v1 模板（每次调用重算 hash，或缓存均可——内容是常量，hash 稳定）。 */
export function uiUxV1Template(): ContinuousTemplateDefinition {
  return defineTemplate(
    CONTINUOUS_TEMPLATE_UI_UX_V1_ID,
    CONTINUOUS_TEMPLATE_UI_UX_V1_VERSION,
    CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT,
  );
}

/** Host 注入 supervisor.templateSource 的注册表（新版本在此追加，不改旧条目内容）。 */
export const CONTINUOUS_TEMPLATES: readonly ContinuousTemplateDefinition[] = [uiUxV1Template()];

export function resolveContinuousTemplate(ref: {
  templateId: string;
  templateVersion: string;
}): ContinuousTemplateDefinition | null {
  return (
    CONTINUOUS_TEMPLATES.find(
      (template) =>
        template.templateId === ref.templateId && template.templateVersion === ref.templateVersion,
    ) ?? null
  );
}
