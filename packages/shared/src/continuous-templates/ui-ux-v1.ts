// ============================================================
// Continuous 固定模板注册表（CT-05 创建；CT-12 自 bootstrap 下沉到 shared）
// ============================================================
// 下沉原因（ticket CT-12）：Host 侧（services/desktop 的 supervisor 装配）与 CLI 侧
// （bootstrap 模板 harness）需要**同一份** templateId@version + 脚本 sha256 绑定——Program
// 授权绑定模板 hash，两边各持一份会出现两套 hash 事实。本文件因此是唯一注册表；
// bootstrap 的同名文件改为再导出 shim（既有 importer 不改）。
//
// 本入口刻意**不**经 continuous-protocol.ts / shared 根入口再导出：注册表用 node:crypto
// 计算 hash，而根入口被 renderer/web 消费（browser-safe 约束，见 services browserSafe
// 回归）。Node 侧消费者（services/desktop/bootstrap）经 `@zcode/shared/continuous-templates`
// 显式引入。
//
// 版本化纪律：模板内容变更必须升 templateVersion 并保留旧条目（授权绑定 hash 的 Program
// 按旧 hash 继续 resolve；旧模板不可用则明确失败，不静默换脚本，规格 §6）。

import { createHash } from "node:crypto";
import { CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT } from "./ui-ux-v1-script.js";

/** 模板身份（Program.templateId/templateVersion 的值）。CT-11 起版本为 "2"（可信工具端口版）。 */
export const CONTINUOUS_TEMPLATE_UI_UX_V1_ID = "ui-ux-v1";
export const CONTINUOUS_TEMPLATE_UI_UX_V1_VERSION = "2";

/**
 * 模板脚本文本（实现在 ./ui-ux-v1-script.ts——max-file-lines 拆分，非边界变化）。
 * 刻意只用字符串拼接（无内嵌模板字面量）；编译检查在 bootstrap template.test.ts 用真实
 * 编译器钉住（编译失败 = 模板不可用 = 明确失败，不静默换脚本，规格 §6）。
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
