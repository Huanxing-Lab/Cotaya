// CT-12：模板注册表唯一实现已下沉到 @zcode/shared/continuous-templates（Host 侧装配与
// CLI 侧 harness 共用同一份 templateId@version+hash 绑定，见那边文件头）。本文件保留为
// 再导出 shim——既有 importer（template.test.ts 等）不改；删除 shim 前先清点引用。
export {
  CONTINUOUS_TEMPLATE_UI_UX_V1_ID,
  CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT,
  CONTINUOUS_TEMPLATE_UI_UX_V1_VERSION,
  CONTINUOUS_TEMPLATES,
  type ContinuousTemplateDefinition,
  resolveContinuousTemplate,
  uiUxV1Template,
} from "@zcode/shared/continuous-templates";
